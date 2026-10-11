import { EventEmitter } from "events";
import crypto from "crypto";
import WebSocket from "ws";

// Ensy moved InoVent units to the BITZER Smart Connect cloud (Lodam LMC311 controller).
// Login uses the official mobile app's OIDC client: many accounts have no web access, which
// rules out the web SPA client. Reads use the web Configurations/AsJSON endpoint with that token.
const LOGIN_BASE = "https://login.bitzersmartconnect.com";
const API_BASE = "https://api.bitzersmartconnect.com/api";
const WWW_BASE = "https://www.bitzersmartconnect.com";
const SIGNALR_HUB = "https://api.bitzersmartconnect.com/signalr/deviceHub";

// From the BITZER Smart Connect app (assets/config-bitzer.json, "Live" environment).
const MOBILE_CLIENT = {
	id: "Bitzer.Balder.Code",
	secret: "j435jgjg345kgj34k5jgf32sv354",
	redirectUri: "de.bitzer.balder:/oauth2redirect",
	scope: "webapi_scope openid offline_access profile email balder_scope",
};

const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const HUB_RECONNECT_MIN_MS = 5_000;
const HUB_RECONNECT_MAX_MS = 300_000;
const HUB_RX_TIMEOUT_MS = 45_000; // server pings every ~16s
const HUB_KEEPALIVE_MS = 15_000;
const POLL_INTERVAL_MS = 120_000;
const HTTP_TIMEOUT_MS = 15_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const ANTIFORGERY_RE =
	/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/;
const RS = "\x1e"; // SignalR record separator

export const PARAM = {
	FAN: "Control.VentSet",
	TARGET_TEMPERATURE: "Control.TempSet",
	SUPPLY: "Input.T7_Inlet",
	EXTRACT: "Input.T3_Exhaust",
	EXHAUST: "Input.T18_Rotor",
	OUTSIDE: "Input.T8_Outdoor",
	HEATER: "Input.T9_Heater",
	HUMIDITY: "AirQual.RH",
} as const;

export const FAN_MODE = {
	MIN: 1,
	NORMAL: 2,
	MAX: 3,
} as const;

export type FanMode = (typeof FAN_MODE)[keyof typeof FAN_MODE];

export interface BitzerDevice {
	id: number;
	name: string;
	productName?: string;
	online: boolean;
}

interface Parameter {
	id: string; // e.g. "_USER.Control.VentSet"
	value: string | null;
}

export class BitzerAuthError extends Error {}

/** Cookie jar sufficient for the Bitzer IdP/MVC hosts. */
class CookieJar {
	private cookies: { name: string; value: string; domain: string; hostOnly: boolean }[] = [];

	store(url: string, res: Response) {
		const host = new URL(url).hostname;
		const headers = res.headers as Headers & { getSetCookie?: () => string[] };
		for (const raw of headers.getSetCookie?.() ?? []) {
			const [nameValue, ...attrs] = raw.split(";");
			const eq = nameValue.indexOf("=");
			const name = nameValue.slice(0, eq).trim();
			const value = nameValue.slice(eq + 1).trim();
			let domain = host;
			let hostOnly = true;
			for (const attr of attrs) {
				const [k, v] = attr.trim().split("=");
				if (k.toLowerCase() === "domain" && v) {
					domain = v.replace(/^\./, "").toLowerCase();
					hostOnly = false;
				}
			}
			this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
			if (value) this.cookies.push({ name, value, domain, hostOnly });
		}
	}

	header(url: string): string {
		const host = new URL(url).hostname;
		return this.cookies
			.filter((c) =>
				c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`),
			)
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");
	}

	clear() {
		this.cookies = [];
	}
}

interface HttpResult {
	status: number;
	location: string;
	text: string;
}

export class BitzerClient extends EventEmitter {
	private jar = new CookieJar();
	private accessToken?: string;
	private tokenExpiresAt = 0;
	private parameters = new Map<string, Parameter>(); // keyed by short key, e.g. "Control.VentSet"
	private online = false;
	private ws?: WebSocket;
	private hubTimer?: NodeJS.Timeout;
	private keepaliveTimer?: NodeJS.Timeout;
	private rxTimer?: NodeJS.Timeout;
	private pollTimer?: NodeJS.Timeout;
	private hubBackoff = HUB_RECONNECT_MIN_MS;
	private invocationId = 0;
	private stopped = true;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private username: string,
		private password: string,
		private deviceId?: number,
	) {
		super();
	}

	// -- public API -------------------------------------------------------------

	/** Log in (validates credentials) and return the account's devices. */
	async listDevices(): Promise<BitzerDevice[]> {
		const devices = await this.getJson(`${API_BASE}/Device/GetUserDevices`);
		return (devices ?? []).map((d: any) => ({
			id: d.deviceId ?? d.id,
			name: d.deviceName ?? `Device ${d.deviceId ?? d.id}`,
			productName: d.productName,
			online: Boolean(d.online),
		}));
	}

	/** Fetch a snapshot, then keep values fresh via the SignalR hub plus a slow reconcile poll. */
	async start(): Promise<void> {
		this.stopped = false;
		await this.refresh();
		this.connectHub();
		this.pollTimer = setInterval(() => {
			this.refresh().catch((err) => this.emit("error", err));
		}, POLL_INTERVAL_MS);
	}

	stop(): void {
		this.stopped = true;
		clearInterval(this.pollTimer);
		clearTimeout(this.hubTimer);
		this.closeHub();
	}

	getValue(key: string): number | undefined {
		const raw = this.parameters.get(key)?.value;
		if (raw === null || raw === undefined || raw === "") return undefined;
		const value = Number(raw);
		return Number.isFinite(value) ? value : undefined;
	}

	isOnline(): boolean {
		return this.online;
	}

	setFanMode(mode: FanMode): Promise<void> {
		return this.setParameters({ [PARAM.FAN]: String(mode) });
	}

	setTargetTemperature(temperature: number): Promise<void> {
		return this.setParameters({ [PARAM.TARGET_TEMPERATURE]: temperature.toFixed(1) });
	}

	/** Write parameters one by one; writes are serialized so they reach the unit in order. */
	setParameters(changes: Record<string, string>): Promise<void> {
		const run = this.writeQueue.then(() => this.save(changes));
		this.writeQueue = run.catch(() => undefined);
		return run;
	}

	// -- reads --------------------------------------------------------------------

	async refresh(): Promise<void> {
		const config = await this.getJson(
			`${WWW_BASE}/Configurations/AsJSON/?deviceId=${this.requireDeviceId()}&_=${Date.now()}`,
			{ "X-Requested-With": "XMLHttpRequest" },
		);
		const parameters = new Map<string, Parameter>();
		for (const group of config?.groups ?? []) {
			for (const p of group.viewParameters ?? []) {
				parameters.set(shortKey(p.id), {
					id: p.id,
					value: p.actualValue === null || p.actualValue === undefined ? null : String(p.actualValue),
				});
			}
		}
		this.parameters = parameters;
		this.setOnline(Boolean(config?.deviceOnline));
		this.emit("update");
	}

	// -- writes -------------------------------------------------------------------

	/**
	 * Writes go through the endpoint the official app and Google Home use. The web form
	 * (Configurations/Save) also accepts writes, but they are often never delivered to the unit.
	 */
	private async save(changes: Record<string, string>): Promise<void> {
		const deviceId = this.requireDeviceId();
		if (this.parameters.size === 0) await this.refresh();
		for (const [key, value] of Object.entries(changes)) {
			const param = this.parameters.get(key);
			if (!param) throw new Error(`Unknown parameter ${key}`);
			for (let attempt = 0; attempt < 2; attempt++) {
				const res = await this.http("POST", `${API_BASE}/GoogleHome/update-device-parameter`, {
					json: { DeviceId: deviceId, ParameterId: param.id, Value: value },
					headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json" },
				});
				if (res.status === 401) {
					this.accessToken = undefined;
					continue;
				}
				// "false" is also returned when the value was already set, so confirm against the unit.
				const accepted =
					res.status === 200 &&
					(res.text.trim() === "true" || (await this.readParameter(param.id)) === Number(value));
				if (!accepted) {
					throw new Error(`Bitzer rejected ${key}=${value} (${res.status} ${res.text.slice(0, 100)})`);
				}
				param.value = value;
				break;
			}
		}
		this.emit("update");
	}

	private async readParameter(parameterId: string): Promise<number | undefined> {
		const param = await this.getJson(
			`${API_BASE}/GoogleHome/get-device-parameter/${this.requireDeviceId()}?parameterId=${encodeURIComponent(parameterId)}`,
		);
		const value = Number(param?.actualValue);
		return Number.isFinite(value) ? value : undefined;
	}

	// -- realtime (SignalR JSON hub protocol) -------------------------------------

	private async connectHub(): Promise<void> {
		if (this.stopped) return;
		try {
			const token = await this.token();
			const negotiate = await fetch(`${SIGNALR_HUB}/negotiate?negotiateVersion=1`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (!negotiate.ok) throw new Error(`negotiate ${negotiate.status}`);
			const info: any = await negotiate.json();
			const connectionToken = info.connectionToken ?? info.connectionId;
			const url = `${SIGNALR_HUB.replace("https://", "wss://")}?id=${connectionToken}&access_token=${token}`;
			const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
			this.ws = ws;

			ws.on("open", () => {
				ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
				const device = this.requireDeviceId();
				// Only subscribe. The official client also calls DeviceActivated/SetActiveViewString while
				// its settings page is open; holding that view permanently appears to keep the gateway busy
				// polling every parameter, which starves writes.
				this.invoke("Subscribe", [`${device}_Updates`]);
				this.hubBackoff = HUB_RECONNECT_MIN_MS;
				this.keepaliveTimer = setInterval(() => ws.send(JSON.stringify({ type: 6 }) + RS), HUB_KEEPALIVE_MS);
				this.armRxTimeout();
			});
			ws.on("message", (data) => {
				this.armRxTimeout();
				for (const part of data.toString().split(RS)) {
					if (part) this.handleHubMessage(part);
				}
			});
			ws.on("close", () => this.scheduleHubReconnect());
			ws.on("error", (err) => {
				this.emit("error", err);
				ws.terminate();
			});
		} catch (err) {
			this.emit("error", err);
			this.scheduleHubReconnect();
		}
	}

	private handleHubMessage(part: string) {
		let msg: any;
		try {
			msg = JSON.parse(part);
		} catch {
			return;
		}
		if (msg.type !== 1 || !msg.target) return;
		const args: any[] = msg.arguments ?? [];
		if (msg.target === "parametersUpdatedJSON" && args.length) {
			const deltas = typeof args[0] === "string" ? JSON.parse(args[0]) : args[0];
			let changed = false;
			for (const delta of deltas ?? []) {
				const param = delta?.Name ? this.parameters.get(shortKey(delta.Name)) : undefined;
				if (!param) continue;
				const value = delta.ActualValueAsString ?? (delta.ActualValue != null ? String(delta.ActualValue) : null);
				if (value !== null && value !== param.value) {
					param.value = String(value);
					changed = true;
				}
			}
			if (changed) this.emit("update");
		} else if (msg.target === "deviceStatusChanged" && args.length) {
			this.setOnline(Boolean(args[0]));
		}
	}

	private invoke(target: string, args: unknown[]) {
		this.invocationId += 1;
		this.ws?.send(
			JSON.stringify({ arguments: args, invocationId: String(this.invocationId), target, type: 1 }) + RS,
		);
	}

	private armRxTimeout() {
		clearTimeout(this.rxTimer);
		// A silent socket without a close frame is half-open; drop it so it reconnects.
		this.rxTimer = setTimeout(() => this.ws?.terminate(), HUB_RX_TIMEOUT_MS);
	}

	private closeHub() {
		clearInterval(this.keepaliveTimer);
		clearTimeout(this.rxTimer);
		const ws = this.ws;
		this.ws = undefined;
		ws?.removeAllListeners();
		ws?.on("error", () => undefined);
		ws?.terminate();
	}

	private scheduleHubReconnect() {
		this.closeHub();
		if (this.stopped) return;
		clearTimeout(this.hubTimer);
		this.hubTimer = setTimeout(() => this.connectHub(), this.hubBackoff);
		this.hubBackoff = Math.min(this.hubBackoff * 2, HUB_RECONNECT_MAX_MS);
	}

	private setOnline(online: boolean) {
		if (online !== this.online) {
			this.online = online;
			this.emit(online ? "online" : "offline");
		}
	}

	// -- auth -----------------------------------------------------------------------

	private async token(): Promise<string> {
		if (!this.accessToken || Date.now() > this.tokenExpiresAt - TOKEN_MARGIN_MS) {
			await this.login();
		}
		return this.accessToken!;
	}

	/** Authorization-code + PKCE login as the mobile app, posting the credentials to the IdP form. */
	private async login(): Promise<void> {
		this.jar.clear();
		const verifier = crypto.randomBytes(32).toString("base64url");
		const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
		const query = new URLSearchParams({
			client_id: MOBILE_CLIENT.id,
			redirect_uri: MOBILE_CLIENT.redirectUri,
			response_type: "code",
			scope: MOBILE_CLIENT.scope,
			state: crypto.randomBytes(12).toString("base64url"),
			code_challenge: challenge,
			code_challenge_method: "S256",
		});

		let url = `${LOGIN_BASE}/connect/authorize?${query}`;
		let loginUrl: string | undefined;
		for (let i = 0; i < 8 && !loginUrl; i++) {
			const res = await this.http("GET", url);
			if (!REDIRECTS.includes(res.status) || !res.location) {
				throw new Error(`Bitzer authorize returned ${res.status}`);
			}
			url = absolute(url, res.location);
			if (/\/account\/login/i.test(url)) loginUrl = url;
		}
		if (!loginUrl) throw new Error("Bitzer login page not found");

		const page = await this.http("GET", loginUrl);
		const forms = page.text.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? [];
		const fields = formInputs(forms.find((f) => f.includes('name="Password"')) ?? page.text);
		fields.__RequestVerificationToken ||= page.text.match(ANTIFORGERY_RE)?.[1] ?? "";
		const offset = -new Date().getTimezoneOffset();
		const sign = offset >= 0 ? "+" : "-";
		const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
		const mm = String(Math.abs(offset) % 60).padStart(2, "0");
		Object.assign(fields, {
			Username: this.username,
			Password: this.password,
			RememberLogin: "true",
			ClientTimezoneOffsetMinutes: String(-offset),
			ClientTimeZoneOffset: encodeURIComponent(`${sign}${hh}:${mm}`),
		});

		const post = await this.http("POST", loginUrl, {
			body: new URLSearchParams(fields),
			headers: { Origin: LOGIN_BASE, Referer: loginUrl },
		});
		if (!REDIRECTS.includes(post.status)) {
			throw new BitzerAuthError("Bitzer rejected the username or password");
		}

		let current = absolute(loginUrl, post.location);
		let code: string | null = null;
		for (let i = 0; i < 6; i++) {
			if (current.startsWith(MOBILE_CLIENT.redirectUri)) {
				code = new URL(current.replace(MOBILE_CLIENT.redirectUri, "https://callback/")).searchParams.get("code");
				break;
			}
			const res = await this.http("GET", current);
			if (!REDIRECTS.includes(res.status) || !res.location) break;
			current = res.location.startsWith(MOBILE_CLIENT.redirectUri) ? res.location : absolute(current, res.location);
		}
		if (!code) throw new BitzerAuthError("Bitzer did not return an authorization code");

		const tokenRes = await this.http("POST", `${LOGIN_BASE}/connect/token`, {
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: MOBILE_CLIENT.redirectUri,
				client_id: MOBILE_CLIENT.id,
				client_secret: MOBILE_CLIENT.secret,
				code_verifier: verifier,
			}),
		});
		if (tokenRes.status !== 200) throw new BitzerAuthError(`Bitzer token request failed (${tokenRes.status})`);
		const token = JSON.parse(tokenRes.text);
		this.accessToken = token.access_token;
		this.tokenExpiresAt = Date.now() + Number(token.expires_in ?? 3600) * 1000;
	}

	// -- http -----------------------------------------------------------------------

	private async getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await this.http("GET", url, {
				headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json", ...headers },
			});
			if (res.status === 401 || REDIRECTS.includes(res.status)) {
				this.accessToken = undefined;
				continue;
			}
			if (res.status !== 200) throw new Error(`Bitzer ${new URL(url).pathname} returned ${res.status}`);
			return res.text ? JSON.parse(res.text) : null;
		}
		throw new Error(`Bitzer ${new URL(url).pathname} unauthorized`);
	}

	private async http(
		method: string,
		url: string,
		options: { body?: URLSearchParams; json?: unknown; headers?: Record<string, string> } = {},
	): Promise<HttpResult> {
		const headers: Record<string, string> = { "User-Agent": "ensy-homey", ...options.headers };
		const cookie = this.jar.header(url);
		if (cookie) headers.Cookie = cookie;
		if (options.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
		if (options.json !== undefined) headers["Content-Type"] = "application/json";
		const started = Date.now();
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers,
				body: options.json !== undefined ? JSON.stringify(options.json) : options.body?.toString(),
				redirect: "manual",
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (error) {
			const { host, pathname } = new URL(url);
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${method} ${host}${pathname} failed after ${Date.now() - started} ms: ${reason}`);
		}
		this.jar.store(url, res);
		return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
	}

	private requireDeviceId(): number {
		if (this.deviceId === undefined) throw new Error("No Bitzer device selected");
		return this.deviceId;
	}
}

function shortKey(id: string): string {
	return id.startsWith("_USER.") ? id.slice(6) : id;
}


function absolute(current: string, location: string): string {
	return location.startsWith("http") ? location : new URL(location, current).toString();
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function formInputs(html: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
		const name = tag.match(/name=["']([^"']*)["']/);
		const value = tag.match(/value=["']([^"']*)["']/);
		if (name) out[name[1]] = value ? decodeHtml(value[1]) : "";
	}
	return out;
}
