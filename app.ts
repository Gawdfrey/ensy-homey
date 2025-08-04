"use strict";

import Homey from "homey";

module.exports = class EnsyHomeyApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log("Ensy Homey App has been initialized");

    // Register flow cards
    this.registerFlowCards();
  }

  private registerFlowCards() {
    // Action cards
    const setPresetModeAction =
      this.homey.flow.getActionCard("set_preset_mode");
    setPresetModeAction.registerRunListener(async (args) => {
      await args.device.setPresetModeAction(args.preset_mode);
    });

    // Condition cards
    const isHeatingCondition = this.homey.flow.getConditionCard("is_heating");
    isHeatingCondition.registerRunListener(async (args) => {
      return args.device.getCapabilityValue("onoff.heating") === true;
    });

    const presetModeCondition =
      this.homey.flow.getConditionCard("preset_mode_is");
    presetModeCondition.registerRunListener(async (args) => {
      const currentMode = args.device.getCapabilityValue("thermostat_mode");
      return currentMode === args.preset_mode;
    });
  }
};
