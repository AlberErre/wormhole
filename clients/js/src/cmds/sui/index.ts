import yargs from "yargs";
import { Yargs } from "../Yargs";
import { addBuildCommands } from "./build";
import { addDeployCommands } from "./deploy";
import { addInitCommands } from "./init";
import { addPublishMessageCommands } from "./publish_message";
import { addSetupCommands } from "./setup";
import { addUtilsCommands } from "./utils";

export const command = "sui";
export const desc = "Sui utilities";
export const builder = function (y: typeof yargs) {
  return new Yargs(y)
    .addCommands(addBuildCommands)
    .addCommands(addDeployCommands)
    .addCommands(addInitCommands)
    .addCommands(addPublishMessageCommands)
    .addCommands(addSetupCommands)
    .addCommands(addUtilsCommands)
    .y()
    .strict()
    .demandCommand();
};
export const handler = (argv) => {};
