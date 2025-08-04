import Homey from "homey";
import {
  EnsyClient,
  EnsyState,
  FanMode,
  PresetMode,
} from "../../lib/ensy-client.js";

export = class EnsyClimateDevice extends Homey.Device {
  private ensyClient?: EnsyClient;

  async onInit() {
    const data = this.getData();
    this.log("Ensy Climate Device has been initialized");

    // Initialize client
    this.ensyClient = new EnsyClient(data.mac_address);

    // Set up event listeners
    this.ensyClient.on(
      "stateUpdate",
      (state: EnsyState, previousState: EnsyState) => {
        this.updateCapabilityValues(state, previousState);
      }
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
      this.onTargetTemperatureChanged.bind(this)
    );
    this.registerCapabilityListener(
      "thermostat_mode",
      this.onThermostatModeChanged.bind(this)
    );
    this.registerCapabilityListener(
      "fan_speed",
      this.onFanSpeedChanged.bind(this)
    );
    this.registerCapabilityListener(
      "onoff.heating",
      this.onHeatingChanged.bind(this)
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
        case PresetMode.AWAY:
          thermostatMode = "off";
          break;
        case PresetMode.BOOST:
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
      const fanSpeed = state.fanMode / 3; // Convert 1-3 to 0.33-1.0
      this.setCapabilityValue("fan_speed", fanSpeed);
    }

    // Update current temperature (use supply temperature as room temperature)
    if (state.temperatureSupply !== undefined) {
      this.setCapabilityValue("measure_temperature", state.temperatureSupply);
    }

    // Update heating indicator and trigger heating events
    if (state.isHeating !== undefined) {
      const previousHeating = this.getCapabilityValue("onoff");
      this.setCapabilityValue("onoff.heating", state.isHeating);

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
        state.temperatureExtract
      );
    }
    if (state.temperatureExhaust !== undefined) {
      this.setCapabilityValue(
        "measure_temperature.exhaust",
        state.temperatureExhaust
      );
    }
    if (state.temperatureOutside !== undefined) {
      this.setCapabilityValue(
        "measure_temperature.outside",
        state.temperatureOutside
      );
    }
    if (state.temperatureHeater !== undefined) {
      this.setCapabilityValue(
        "measure_temperature.heater",
        state.temperatureHeater
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
            this.ensyClient.setPresetMode(PresetMode.AWAY);
            break;
          case "heat":
            this.ensyClient.setPresetMode(PresetMode.HOME);
            break;
          default:
            this.ensyClient.setPresetMode(PresetMode.HOME);
        }
      } catch (error) {
        this.error("Failed to set thermostat mode:", error);
        throw error;
      }
    }
  }

  private async onFanSpeedChanged(value: number) {
    if (this.ensyClient) {
      try {
        // Convert 0.33-1.0 back to 1-3
        const fanMode = Math.max(
          1,
          Math.min(3, Math.round(value * 3))
        ) as FanMode;
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
          this.ensyClient.setPresetMode(PresetMode.HOME);
          break;
        case "away":
          this.ensyClient.setPresetMode(PresetMode.AWAY);
          break;
        case "boost":
          this.ensyClient.setPresetMode(PresetMode.BOOST);
          break;
      }
    }
  }
};
