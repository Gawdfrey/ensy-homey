# Ensy Homey

A Homey Pro app for Ensy InoVent ventilation units, connected through BITZER Smart Connect.

## Features

- **Fan control**: min / normal / max, with a Flow action and a "fan mode changed" trigger
- **Set temperature**: 10–26 °C in 0.5 °C steps
- **Sensors**: supply, extract, exhaust, outside and heater temperature, humidity
- **Alarm**: `alarm_generic` turns on while the unit reports alarms (for example a filter change)

## Installation

1. Make sure the unit works in BITZER Smart Connect (Ensy moved InoVent units there).
2. Add a device in Homey and log in with your BITZER Smart Connect account.
3. Devices added with versions before 0.2.0 (Ensy MQTT): open the device and choose **Repair**.

## How it works

`lib/bitzer-client.ts` talks to the BITZER Smart Connect cloud (Lodam LMC311 controller):

- **Login**: OIDC with the official mobile app's client (`Bitzer.Balder.Code`, authorization code + PKCE). Many accounts have no web access, so the web client cannot be used.
- **Read**: `www.bitzersmartconnect.com/Configurations/AsJSON?deviceId=…` plus `api…/Device/GetDevice/…` for the alarm count, refreshed every 2 minutes.
- **Live updates**: SignalR hub `api…/signalr/deviceHub` (`parametersUpdatedJSON`).
- **Write**: `POST api…/GoogleHome/update-device-parameter` with `{DeviceId, ParameterId, Value}`, the endpoint the official app uses. The web form (`Configurations/Save`) accepts writes but often never delivers them to the unit.

Parameter mapping: `Control.VentSet` (1–3) → fan mode, `Control.TempSet` → target temperature, `Input.T7_Inlet` → supply, `Input.T3_Exhaust` → extract, `Input.T18_Rotor` → exhaust, `Input.T8_Outdoor` → outside, `Input.T9_Heater` → heater, `AirQual.RH` → humidity.

Inspired by [ha-bitzer-smart-connect](https://github.com/alexbrasetvik/ha-bitzer-smart-connect).

## License

MIT License - see LICENSE file for details.
