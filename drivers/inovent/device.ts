import Homey from "homey";
import {
	EnsyClient,
	type EnsyState,
	FAN_MODE,
	type FanMode,
	PRESET_MODE,
} from "../../lib/ensy-client.js";

export = class InoventVentilationDevice extends Homey.Device {
	private ensyClient?: EnsyClient;

	async onInit() {
		const data = this.getData();
		this.log("InoVent Ventilation Device has been initialized");

		// Initialize client
		this.ensyClient = new EnsyClient(data.mac_address);

		// Set up event listeners
		this.ensyClient.on(
			"stateUpdate",
			(state: EnsyState, previousState: EnsyState) => {
				this.updateCapabilityValues(state, previousState);
			},
		);

		this.ensyClient.on("connected", () => {
			this.setAvailable();
		});

		this.ensyClient.on("disconnected", () => {
			this.setUnavailable("Device disconnected");
		});

		this.ensyClient.on("error", (error) => {
			this.error("Ensy client error:", error);
			this.setUnavailable("Connection error");
		});

		// Register capability listeners
		this.registerCapabilityListener(
			"target_temperature",
			this.onTargetTemperatureChanged.bind(this),
		);
		this.registerCapabilityListener(
			"thermostat_mode",
			this.onThermostatModeChanged.bind(this),
		);
		this.registerCapabilityListener(
			"inovent_fan_mode",
			this.onFanSpeedChanged.bind(this),
		);
		this.registerCapabilityListener(
			"onoff.heating",
			this.onHeatingChanged.bind(this),
		);

		// Connect to device
		try {
			await this.ensyClient.connect();
		} catch (error) {
			this.error("Failed to connect to Ensy device:", error);
			this.setUnavailable("Connection failed");
		}
	}

	async onDeleted() {
		if (this.ensyClient) {
			this.ensyClient.disconnect();
		}
	}

	private updateCapabilityValues(state: EnsyState, previousState?: EnsyState) {
		// Update temperature
		if (state.temperatureTarget !== undefined) {
			this.setCapabilityValue("target_temperature", state.temperatureTarget);
		}

		// Update thermostat mode based on preset
		if (state.presetMode !== undefined) {
			const previousMode = previousState?.presetMode;
			let thermostatMode = "heat";
			switch (state.presetMode) {
				case PRESET_MODE.AWAY:
					thermostatMode = "off";
					break;
				case PRESET_MODE.BOOST:
					thermostatMode = "heat";
					break;
				default:
					thermostatMode = "heat";
			}
			this.setCapabilityValue("thermostat_mode", thermostatMode);

			// Trigger preset mode changed if changed
			if (previousMode && previousMode !== state.presetMode) {
				this.homey.flow
					.getDeviceTriggerCard("preset_mode_changed")
					.trigger(this, { preset_mode: state.presetMode });
			}
		}

		// Update fan speed
		if (state.fanMode !== undefined) {
			let fanModeString: "min" | "normal" | "max";
			switch (state.fanMode) {
				case FAN_MODE.MIN:
					fanModeString = "min";
					break;
				case FAN_MODE.NORMAL:
					fanModeString = "normal";
					break;
				case FAN_MODE.MAX:
					fanModeString = "max";
					break;
				default:
					fanModeString = "normal"; // Default to normal if unknown
			}
			this.setCapabilityValue("inovent_fan_mode", fanModeString);

			const previousFanMode = previousState?.fanMode;
			if (previousFanMode !== state.fanMode) {
				this.homey.flow
					.getDeviceTriggerCard("fan_mode_changed")
					.trigger(this, { fan_mode: fanModeString });
			}
		}

		// Update current temperature (use supply temperature as room temperature)
		if (state.temperatureSupply !== undefined) {
			this.setCapabilityValue("measure_temperature", state.temperatureSupply);
		}

		// Update heating indicator and trigger heating events
		if (state.isHeating !== undefined) {
			const previousHeating = this.getCapabilityValue("onoff");
			if (previousHeating !== state.isHeating) {
				if (state.isHeating) {
					this.homey.flow.getDeviceTriggerCard("heating_started").trigger(this);
				} else {
					this.homey.flow.getDeviceTriggerCard("heating_stopped").trigger(this);
				}
			}
		}
		// Update individual temperature sensors
		if (state.temperatureExtract !== undefined) {
			this.setCapabilityValue(
				"measure_temperature.extract",
				state.temperatureExtract,
			);
		}
		if (state.temperatureExhaust !== undefined) {
			this.setCapabilityValue(
				"measure_temperature.exhaust",
				state.temperatureExhaust,
			);
		}
		if (state.temperatureOutside !== undefined) {
			this.setCapabilityValue(
				"measure_temperature.outside",
				state.temperatureOutside,
			);
		}
		if (state.temperatureHeater !== undefined) {
			this.setCapabilityValue(
				"measure_temperature.heater",
				state.temperatureHeater,
			);
		}
	}

	private async onTargetTemperatureChanged(value: number) {
		if (this.ensyClient) {
			try {
				this.ensyClient.setTargetTemperature(Math.round(value));
			} catch (error) {
				this.error("Failed to set target temperature:", error);
				throw error;
			}
		}
	}

	private async onThermostatModeChanged(value: string) {
		if (this.ensyClient) {
			try {
				switch (value) {
					case "off":
						this.ensyClient.setPresetMode(PRESET_MODE.AWAY);
						break;
					case "heat":
						this.ensyClient.setPresetMode(PRESET_MODE.HOME);
						break;
					default:
						this.ensyClient.setPresetMode(PRESET_MODE.HOME);
				}
			} catch (error) {
				this.error("Failed to set thermostat mode:", error);
				throw error;
			}
		}
	}

	private async onFanSpeedChanged(value: "min" | "normal" | "max") {
		if (this.ensyClient) {
			try {
				let fanMode: FanMode;
				switch (value) {
					case "min":
						fanMode = FAN_MODE.MIN;
						break;
					case "normal":
						fanMode = FAN_MODE.NORMAL;
						break;
					case "max":
						fanMode = FAN_MODE.MAX;
						break;
					default:
						fanMode = FAN_MODE.NORMAL; // Default to normal if unknown
				}
				this.ensyClient.setFanMode(fanMode);
			} catch (error) {
				this.error("Failed to set fan speed:", error);
				throw error;
			}
		}
	}

	private async onHeatingChanged(value: boolean) {
		// This is a read-only capability that reflects the device state
		// We don't send commands to the device for this capability
		// Just log the attempt for debugging
		this.log("Heating status change attempt (read-only):", value);

		// Return the current actual state instead of accepting the change
		return this.getCapabilityValue("onoff.heating");
	}

	// Flow card actions
	async setPresetModeAction(presetMode: string) {
		if (this.ensyClient) {
			switch (presetMode) {
				case "home":
					this.ensyClient.setPresetMode(PRESET_MODE.HOME);
					break;
				case "away":
					this.ensyClient.setPresetMode(PRESET_MODE.AWAY);
					break;
				case "boost":
					this.ensyClient.setPresetMode(PRESET_MODE.BOOST);
					break;
			}
		}
	}

	async setFanModeAction(fanMode: string) {
		if (this.ensyClient) {
			switch (fanMode) {
				case "min":
					this.ensyClient.setFanMode(FAN_MODE.MIN);
					break;
				case "normal":
					this.ensyClient.setFanMode(FAN_MODE.NORMAL);
					break;
				case "max":
					this.ensyClient.setFanMode(FAN_MODE.MAX);
					break;
			}
		}
	}
};
