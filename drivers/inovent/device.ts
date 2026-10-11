import Homey from "homey";
import { BitzerClient, FAN_MODE, type FanMode, PARAM } from "../../lib/bitzer-client.js";

type FanModeId = "min" | "normal" | "max";

const FAN_MODE_IDS: Record<number, FanModeId> = {
	[FAN_MODE.MIN]: "min",
	[FAN_MODE.NORMAL]: "normal",
	[FAN_MODE.MAX]: "max",
};

const FAN_MODES: Record<FanModeId, FanMode> = {
	min: FAN_MODE.MIN,
	normal: FAN_MODE.NORMAL,
	max: FAN_MODE.MAX,
};

const SENSORS: [capability: string, param: string][] = [
	["measure_temperature", PARAM.SUPPLY],
	["measure_temperature.extract", PARAM.EXTRACT],
	["measure_temperature.exhaust", PARAM.EXHAUST],
	["measure_temperature.outside", PARAM.OUTSIDE],
	["measure_temperature.heater", PARAM.HEATER],
	["measure_humidity", PARAM.HUMIDITY],
];

export = class InoventVentilationDevice extends Homey.Device {
	private client?: BitzerClient;

	async onInit() {
		this.log("InoVent Ventilation Device has been initialized");

		await this.migrate();

		this.registerCapabilityListener("target_temperature", this.onTargetTemperatureChanged.bind(this));
		this.registerCapabilityListener("inovent_fan_mode", this.onFanModeChanged.bind(this));

		await this.connect();
	}

	/** Bring devices paired by older versions in line with the current driver manifest. */
	private async migrate() {
		for (const capability of ["measure_humidity", "alarm_generic"]) {
			if (!this.hasCapability(capability)) await this.addCapability(capability);
		}
		for (const capability of ["thermostat_mode", "onoff.heating"]) {
			if (this.hasCapability(capability)) await this.removeCapability(capability);
		}
		if (this.getClass() !== "airtreatment") await this.setClass("airtreatment");
		await this.setCapabilityOptions("target_temperature", { min: 10, max: 26, step: 0.5 });
	}

	/** (Re)connect using the stored BITZER Smart Connect login; also called after a repair. */
	async connect() {
		this.client?.stop();
		this.client = undefined;

		const username = this.getStoreValue("username");
		const password = this.getStoreValue("password");
		const deviceId = this.getStoreValue("deviceId");
		if (!username || !password || deviceId === undefined) {
			// Devices paired with the old Ensy MQTT cloud must be repaired with a Bitzer login.
			await this.setUnavailable(this.homey.__("device.repair_required"));
			return;
		}

		const client = new BitzerClient(username, password, deviceId);
		this.client = client;
		client.on("update", () => this.updateCapabilityValues());
		client.on("online", () => this.setAvailable().catch(this.error));
		client.on("offline", () => this.setUnavailable(this.homey.__("device.offline")).catch(this.error));
		client.on("error", (error) => this.error("Bitzer client error:", error));

		try {
			await client.start();
		} catch (error) {
			this.error("Failed to connect to BITZER Smart Connect:", error);
			await this.setUnavailable(this.homey.__("device.connection_failed"));
		}
	}

	async onDeleted() {
		this.client?.stop();
	}

	async onUninit() {
		this.client?.stop();
	}

	private updateCapabilityValues() {
		const client = this.client;
		if (!client) return;

		for (const [capability, param] of SENSORS) {
			const value = client.getValue(param);
			if (value !== undefined && this.getCapabilityValue(capability) !== value) {
				this.setCapabilityValue(capability, value).catch(this.error);
			}
		}

		const alarm = client.getAlarmCount() > 0;
		if (this.getCapabilityValue("alarm_generic") !== alarm) {
			this.setCapabilityValue("alarm_generic", alarm).catch(this.error);
		}

		const target = client.getValue(PARAM.TARGET_TEMPERATURE);
		if (target !== undefined && this.getCapabilityValue("target_temperature") !== target) {
			this.setCapabilityValue("target_temperature", target).catch(this.error);
		}

		const fan = client.getValue(PARAM.FAN);
		const fanMode = fan === undefined ? undefined : FAN_MODE_IDS[fan];
		if (fanMode && this.getCapabilityValue("inovent_fan_mode") !== fanMode) {
			const previous = this.getCapabilityValue("inovent_fan_mode");
			this.setCapabilityValue("inovent_fan_mode", fanMode).catch(this.error);
			if (previous !== null) {
				this.homey.flow
					.getDeviceTriggerCard("fan_mode_changed")
					.trigger(this, { fan_mode: fanMode })
					.catch(this.error);
			}
		}
	}

	private async onTargetTemperatureChanged(value: number) {
		const client = this.requireClient();
		this.runWrite("target temperature", () => client.setTargetTemperature(Math.round(value * 2) / 2));
	}

	private async onFanModeChanged(value: FanModeId) {
		const client = this.requireClient();
		this.runWrite("fan mode", () => client.setFanMode(FAN_MODES[value] ?? FAN_MODE.NORMAL));
	}

	/**
	 * Writes go through several cloud round-trips and can exceed Homey's capability timeout, so they
	 * run in the background. A failure is surfaced and the capabilities fall back to the cloud state.
	 */
	private runWrite(what: string, write: () => Promise<void>) {
		write()
			.then(() => this.unsetWarning().catch(this.error))
			.catch(async (error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.error(`Failed to set ${what}:`, error);
				await this.setWarning(`${this.homey.__("device.write_failed")} ${message}`).catch(this.error);
				await this.homey.notifications
					.createNotification({ excerpt: `Ensy: ${this.homey.__("device.write_failed")} ${what}: ${message}` })
					.catch(this.error);
				await this.client?.refresh().catch(this.error);
			});
	}

	// Flow card actions
	async setFanModeAction(fanMode: FanModeId) {
		await this.requireClient().setFanMode(FAN_MODES[fanMode] ?? FAN_MODE.NORMAL);
		await this.setCapabilityValue("inovent_fan_mode", fanMode);
	}

	private requireClient(): BitzerClient {
		if (!this.client) throw new Error(this.homey.__("device.repair_required"));
		return this.client;
	}
};
