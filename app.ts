import Homey from "homey";

module.exports = class EnsyHomeyApp extends Homey.App {
	async onInit() {
		this.log("Ensy Homey App has been initialized");

		this.homey.flow.getActionCard("set_fan_mode").registerRunListener(async (args) => {
			await args.device.setFanModeAction(args.fan_mode);
		});
	}
};
