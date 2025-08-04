import { EventEmitter } from "events";
import * as mqtt from "mqtt";

const API_HOST = "app.ensy.no";
const API_PORT = 8083;
const MIN_TEMPERATURE = 15;
const MAX_TEMPERATURE = 26;

export enum FanMode {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
}

export enum PresetMode {
  HOME = "home",
  AWAY = "away",
  BOOST = "boost",
}

export interface EnsyState {
  isHeating?: boolean;
  isOnline: boolean;
  fanMode?: FanMode;
  presetMode?: PresetMode;
  temperatureExhaust?: number;
  temperatureExtract?: number;
  temperatureHeater?: number;
  temperatureOutside?: number;
  temperatureSupply?: number;
  temperatureTarget?: number;
}

export class EnsyClient extends EventEmitter {
  private mqttClient?: mqtt.MqttClient;
  private macAddress: string;
  private stateTopicPrefix: string;
  private applyStateTopicPrefix: string;

  public state: EnsyState = {
    isOnline: false,
  };

  constructor(macAddress: string) {
    super();
    this.macAddress = macAddress.replace(/:/g, "").toLowerCase();
    this.stateTopicPrefix = `units/${this.macAddress}/unit/`;
    this.applyStateTopicPrefix = `units/${this.macAddress}/app/`;
  }

  async connect(): Promise<void> {
    const options: mqtt.IClientOptions = {
      host: API_HOST,
      port: API_PORT,
      protocol: "wss",
      path: "/mqtt",
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      rejectUnauthorized: false,
    };

    this.mqttClient = mqtt.connect(options);

    this.mqttClient.on("connect", () => {
      console.log("Connected to Ensy MQTT");
      this.mqttClient?.subscribe(`${this.stateTopicPrefix}#`);
      this.emit("connected");
    });

    this.mqttClient.on("message", (topic, message) => {
      this.handleMessage(topic, message.toString());
    });

    this.mqttClient.on("disconnect", () => {
      console.log("Disconnected from Ensy MQTT");
      this.state.isOnline = false;
      this.emit("disconnected");
    });

    this.mqttClient.on("error", (error) => {
      console.error("MQTT error:", error);
      this.emit("error", error);
    });
  }

  disconnect(): void {
    if (this.mqttClient) {
      this.mqttClient.end();
      this.mqttClient = undefined;
    }
  }

  private handleMessage(topic: string, value: string): void {
    if (!topic.startsWith(this.stateTopicPrefix)) {
      return;
    }

    const key = topic.substring(this.stateTopicPrefix.length);
    const previousState = { ...this.state };

    switch (key) {
      case "temperature":
        this.state.temperatureTarget = parseInt(value);
        break;
      case "status":
        this.state.isOnline = value === "online";
        break;
      case "fan":
        if (["1", "2", "3"].includes(value)) {
          this.state.fanMode = parseInt(value) as FanMode;
        }
        break;
      case "party":
        if (value === "1") {
          this.state.presetMode = PresetMode.BOOST;
        } else if (this.state.presetMode === PresetMode.BOOST) {
          this.state.presetMode = PresetMode.HOME;
        }
        break;
      case "absent":
        if (value === "1") {
          this.state.presetMode = PresetMode.AWAY;
        } else if (this.state.presetMode === PresetMode.AWAY) {
          this.state.presetMode = PresetMode.HOME;
        }
        break;
      case "textr":
        this.state.temperatureExtract = parseInt(value);
        break;
      case "texauh":
        this.state.temperatureExhaust = parseInt(value);
        break;
      case "tsupl":
        this.state.temperatureSupply = parseInt(value);
        break;
      case "tout":
        this.state.temperatureOutside = parseInt(value);
        break;
      case "overheating":
        this.state.temperatureHeater = parseInt(value);
        break;
      case "he":
        this.state.isHeating = value === "1";
        break;
      default:
        return; // Unknown key, don't emit update
    }

    this.emit("stateUpdate", this.state, previousState);
  }

  setTargetTemperature(temperature: number): void {
    if (temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
      throw new Error(
        `Temperature must be between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}`
      );
    }
    this.publish(
      `${this.applyStateTopicPrefix}temperature`,
      temperature.toString()
    );
  }

  setFanMode(speed: FanMode): void {
    if (this.state.presetMode !== PresetMode.HOME) {
      this.setPresetMode(PresetMode.HOME);
    }
    this.publish(`${this.applyStateTopicPrefix}fan`, speed.toString());
  }

  setPresetMode(presetMode: PresetMode): void {
    if (presetMode === this.state.presetMode) {
      return;
    }

    switch (presetMode) {
      case PresetMode.HOME:
        this.applyState("absent", "0");
        this.applyState("party", "2");
        break;
      case PresetMode.AWAY:
        this.applyState("absent", "1");
        break;
      case PresetMode.BOOST:
        this.applyState("party", "1");
        break;
    }
  }

  private applyState(key: string, value: string): void {
    this.publish(`${this.applyStateTopicPrefix}${key}`, value);
  }

  private publish(topic: string, payload: string): void {
    if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish(topic, payload, { qos: 1, retain: true });
    }
  }

  static async testConnectivity(macAddress: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new EnsyClient(macAddress);
      const timeout = setTimeout(() => {
        client.disconnect();
        resolve(false);
      }, 10000);

      client.once("stateUpdate", () => {
        clearTimeout(timeout);
        client.disconnect();
        resolve(true);
      });

      client.once("error", () => {
        clearTimeout(timeout);
        client.disconnect();
        resolve(false);
      });

      client.connect().catch(() => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }
}
