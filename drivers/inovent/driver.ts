import Homey from "homey";
import { BitzerAuthError, BitzerClient, type BitzerDevice } from "../../lib/bitzer-client.js";

interface Credentials {
	username: string;
	password: string;
}

export = class InoventVentilationDriver extends Homey.Driver {
	async onInit() {
		this.log("Ensy Climate Driver has been initialized");
	}

	async onPair(session: any) {
		let credentials: Credentials | undefined;
		let devices: BitzerDevice[] = [];

		session.setHandler("login", async (data: Credentials) => {
			devices = await this.login(data);
			credentials = data;
			return true;
		});

		session.setHandler("list_devices", async () => {
			if (!credentials) throw new Error("Log in to BITZER Smart Connect first");
			return devices.map((device) => ({
				name: device.name,
				data: { id: `bitzer-${device.id}` },
				store: { ...credentials, deviceId: device.id },
			}));
		});
	}

	/** Moves an existing (MQTT-era) device to BITZER Smart Connect without changing its ID, so Flows keep working. */
	async onRepair(session: any, device: any) {
		session.setHandler("login", async (data: Credentials) => {
			const devices = await this.login(data);
			const current = device.getStoreValue("deviceId");
			const target = devices.find((d) => d.id === current) ?? devices[0];
			if (devices.length > 1 && !devices.some((d) => d.id === current)) {
				this.log("Several Bitzer devices found, using the first:", devices);
			}
			await device.setStoreValue("username", data.username);
			await device.setStoreValue("password", data.password);
			await device.setStoreValue("deviceId", target.id);
			await device.connect();
			return true;
		});
	}

	private async login(data: Credentials): Promise<BitzerDevice[]> {
		try {
			const devices = await new BitzerClient(data.username, data.password).listDevices();
			if (devices.length === 0) throw new Error("No devices found on this BITZER Smart Connect account");
			return devices;
		} catch (error) {
			this.error("Bitzer login failed:", error);
			if (error instanceof BitzerAuthError) throw new Error(this.homey.__("pair.login_failed"));
			throw error;
		}
	}
};
