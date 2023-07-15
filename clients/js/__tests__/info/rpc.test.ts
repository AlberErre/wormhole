import { describe, expect, it } from "@jest/globals";
import { run_worm_command } from "../utils/cli";
import { NETWORKS as RPC_NETWORKS } from "../../src/consts/networks";
import { getChains, networks } from "../utils/getters";
import { Network } from "@certusone/wormhole-sdk/lib/esm/utils/consts";

describe("worm info rpc", () => {
  describe("check functionality", () => {
    const chains = getChains();

    networks.forEach((network) => {
      const NETWORK = network.toUpperCase() as Network;

      chains.forEach((chain) => {
        it(`should return ${chain} ${network} rpc correctly`, async () => {
          const output = run_worm_command(`info rpc ${network} ${chain}`);

          expect(output).toContain(String(RPC_NETWORKS[NETWORK][chain].rpc));
        });
      });
    });
  });
});
