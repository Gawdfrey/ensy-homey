import Homey from "homey";

export = class InoventVentilationDriver extends Homey.Driver {
  async onInit() {
    this.log("Ensy Climate Driver has been initialized");
  }

  async onPair(session: any) {
    let discoveredDevices: any[] = [];

    session.setHandler("list_devices", async () => {
      return discoveredDevices;
    });

    session.setHandler(
      "manual_pairing",
      async (data: { mac_address: string }) => {
        const { EnsyClient } = await import("../../lib/ensy-client.js");

        try {
          this.log("Testing connectivity for device:", data.mac_address);
          const isValid = await EnsyClient.testConnectivity(data.mac_address);

          if (isValid) {
            const device = {
              name: `Ensy (${data.mac_address})`,
              data: {
                id: data.mac_address.replace(/:/g, "").toLowerCase(),
                mac_address: data.mac_address,
              },
            };

            discoveredDevices = [device];
            this.log("Device validated successfully:", device);
            return { success: true };
          } else {
            throw new Error(
              "Could not connect to device - please check MAC address and network connectivity"
            );
          }
        } catch (error) {
          this.error("Manual pairing failed:", error);
          throw error;
        }
      }
    );
  }
};
