import Homey from 'homey';

export = class EnsyClimateDriver extends Homey.Driver {

  async onInit() {
    this.log('Ensy Climate Driver has been initialized');
  }

  async onPair(session: any) {
    session.setHandler('showView', async (viewId: string) => {
      if (viewId === 'loading') {
        // Auto-discover devices via DHCP/network scan
        await this.discoverDevices(session);
      }
    });

    session.setHandler('manual_pairing', async (data: { mac_address: string, allow_insecure_tls: boolean }) => {
      const { EnsyClient } = await import('../../lib/ensy-client.js');
      
      try {
        const isValid = await EnsyClient.testConnectivity(data.mac_address, data.allow_insecure_tls);
        if (isValid) {
          return {
            success: true,
            device: {
              name: `Ensy (${data.mac_address})`,
              data: {
                mac_address: data.mac_address,
                allow_insecure_tls: data.allow_insecure_tls
              }
            }
          };
        } else {
          throw new Error('Could not connect to device');
        }
      } catch (error) {
        this.error('Manual pairing failed:', error);
        throw error;
      }
    });
  }

  private async discoverDevices(session: any) {
    // In a real implementation, we would scan the network for Ensy devices
    // For now, we'll skip to manual pairing
    setTimeout(() => {
      session.nextView();
    }, 2000);
  }

};