'use strict';

import Homey from 'homey';

module.exports = class EnsyHomeyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Ensy Homey App has been initialized');
    
    // Register flow cards
    this.registerFlowCards();
  }

  private registerFlowCards() {
    // Action cards
    const setPresetModeAction = this.homey.flow.getActionCard('set_preset_mode');
    setPresetModeAction.registerRunListener(async (args, state) => {
      await args.device.setPresetModeAction(args.preset_mode);
    });

    // Condition cards
    const isHeatingCondition = this.homey.flow.getConditionCard('is_heating');
    isHeatingCondition.registerRunListener(async (args, state) => {
      return args.device.getCapabilityValue('heating') === true;
    });

    const presetModeCondition = this.homey.flow.getConditionCard('preset_mode_is');
    presetModeCondition.registerRunListener(async (args, state) => {
      const currentMode = args.device.getCapabilityValue('thermostat_mode');
      return currentMode === args.preset_mode;
    });

    // Trigger cards
    const heatingStartedTrigger = this.homey.flow.getDeviceTriggerCard('heating_started');
    const heatingStoppedTrigger = this.homey.flow.getDeviceTriggerCard('heating_stopped');
    const presetModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('preset_mode_changed');

    // These will be triggered from the device when state changes
  }

}
