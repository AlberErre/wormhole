import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { ContractReceipt, ethers } from "ethers";
import {
  getNetwork,
  isCI,
  generateRandomString,
  waitForRelay,
  PRIVATE_KEY,
  getGuardianRPC,
  GUARDIAN_KEYS,
  GUARDIAN_SET_INDEX,
  GOVERNANCE_EMITTER_ADDRESS,
  getArbitraryBytes32,
} from "./utils/utils";
import { getAddressInfo } from "../consts";
import { getDefaultProvider } from "../relayer/helpers";
import {
  relayer,
  ethers_contracts,
  tryNativeToUint8Array,
  ChainId,
  CHAINS,
  CONTRACTS,
  CHAIN_ID_TO_NAME,
  ChainName,
  Network,
  parseSequencesFromLogEth,
} from "../../../";
import { GovernanceEmitter, MockGuardians } from "../../../src/mock";
import { AddressInfo } from "net";
import {
  Bridge__factory,
  Implementation__factory,
} from "../../ethers-contracts";
import { Wormhole__factory } from "../../../lib/cjs/ethers-contracts";
import { getEmitterAddressEth } from "../../bridge";
import { deliver } from "../relayer";
import { env } from "process";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import { getSignedVAAWithRetry } from "../../rpc";

const network: Network = getNetwork();
const ci: boolean = isCI();

const sourceChain = network == "DEVNET" ? "ethereum" : "celo";
const targetChain = network == "DEVNET" ? "bsc" : "avalanche";

const testIfDevnet = () => (network == "DEVNET" ? test : test.skip);

type TestChain = {
  chainId: ChainId;
  name: ChainName;
  provider: ethers.providers.Provider;
  wallet: ethers.Wallet;
  wormholeRelayerAddress: string;
  mockIntegrationAddress: string;
  wormholeRelayer: ethers_contracts.WormholeRelayer;
  mockIntegration: ethers_contracts.MockRelayerIntegration;
};

const createTestChain = (name: ChainName) => {
  const provider = getDefaultProvider(network, name, ci);
  const addressInfo = getAddressInfo(name, network);
  if (process.env.DEV) {
    // Via ir is off -> different wormhole relayer address
    addressInfo.wormholeRelayerAddress =
      "0x53855d4b64E9A3CF59A84bc768adA716B5536BC5";
  }
  if (network == "MAINNET")
    addressInfo.mockIntegrationAddress =
      "0xa507Ff8D183D2BEcc9Ff9F82DFeF4b074e1d0E05";
  if (network == "MAINNET")
    addressInfo.mockDeliveryProviderAddress =
      "0x7A0a53847776f7e94Cc35742971aCb2217b0Db81";

  if (!addressInfo.wormholeRelayerAddress)
    throw Error(`No core relayer address for ${name}`);
  if (!addressInfo.mockIntegrationAddress)
    throw Error(`No mock relayer integration address for ${name}`);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const wormholeRelayer = ethers_contracts.WormholeRelayer__factory.connect(
    addressInfo.wormholeRelayerAddress,
    wallet
  );
  const mockIntegration =
    ethers_contracts.MockRelayerIntegration__factory.connect(
      addressInfo.mockIntegrationAddress,
      wallet
    );
  const result: TestChain = {
    chainId: CHAINS[name],
    name,
    provider,
    wallet,
    wormholeRelayerAddress: addressInfo.wormholeRelayerAddress,
    mockIntegrationAddress: addressInfo.mockIntegrationAddress,
    wormholeRelayer,
    mockIntegration,
  };
  return result;
};

const source = createTestChain(sourceChain);
const target = createTestChain(targetChain);

const myMap = new Map<ChainName, ethers.providers.Provider>();
myMap.set(sourceChain, source.provider);
myMap.set(targetChain, target.provider);
const optionalParams = {
  environment: network,
  sourceChainProvider: source.provider,
  targetChainProviders: myMap,
  wormholeRelayerAddress: source.wormholeRelayerAddress,
};
const optionalParamsTarget = {
  environment: network,
  sourceChainProvider: target.provider,
  targetChainProviders: myMap,
  wormholeRelayerAddress: target.wormholeRelayerAddress,
};

// for signing wormhole messages
const guardians = new MockGuardians(GUARDIAN_SET_INDEX, GUARDIAN_KEYS);

// for generating governance wormhole messages
const governance = new GovernanceEmitter(GOVERNANCE_EMITTER_ADDRESS);

const guardianIndices = ci ? [0, 1] : [0];

const REASONABLE_GAS_LIMIT = 500000;
const TOO_LOW_GAS_LIMIT = 10000;
const REASONABLE_GAS_LIMIT_FORWARDS = 900000;

const wormholeRelayerAddresses = new Map<ChainName, string>();
wormholeRelayerAddresses.set(sourceChain, source.wormholeRelayerAddress);
wormholeRelayerAddresses.set(targetChain, target.wormholeRelayerAddress);

const getStatus = async (
  txHash: string,
  _sourceChain?: ChainName
): Promise<string> => {
  const info = (await relayer.getWormholeRelayerInfo(
    _sourceChain || sourceChain,
    txHash,
    {
      environment: network,
      targetChainProviders: myMap,
      sourceChainProvider: myMap.get(_sourceChain || sourceChain),
      wormholeRelayerAddresses,
    }
  )) as relayer.DeliveryInfo;
  return info.targetChainStatus.events[0].status;
};

const testSend = async (
  payload: string,
  sendToSourceChain?: boolean,
  notEnoughValue?: boolean
): Promise<ContractReceipt> => {
  const value = await relayer.getPrice(
    sourceChain,
    sendToSourceChain ? sourceChain : targetChain,
    notEnoughValue ? TOO_LOW_GAS_LIMIT : REASONABLE_GAS_LIMIT,
    optionalParams
  );
  console.log(`Quoted gas delivery fee: ${value}`);
  const tx = await source.mockIntegration.sendMessage(
    payload,
    sendToSourceChain ? source.chainId : target.chainId,
    notEnoughValue ? TOO_LOW_GAS_LIMIT : REASONABLE_GAS_LIMIT,
    0,
    { value, gasLimit: REASONABLE_GAS_LIMIT }
  );
  console.log(`Sent delivery request! Transaction hash ${tx.hash}`);
  await tx.wait();
  console.log("Message confirmed!");

  return tx.wait();
};

const testForward = async (
  payload1: string,
  payload2: string,
  notEnoughExtraForwardingValue?: boolean
): Promise<ContractReceipt> => {
  const valueNeededOnTargetChain = await relayer.getPrice(
    targetChain,
    sourceChain,
    notEnoughExtraForwardingValue ? TOO_LOW_GAS_LIMIT : REASONABLE_GAS_LIMIT,
    optionalParamsTarget
  );
  const value = await relayer.getPrice(
    sourceChain,
    targetChain,
    REASONABLE_GAS_LIMIT_FORWARDS,
    { receiverValue: valueNeededOnTargetChain, ...optionalParams }
  );
  console.log(`Quoted gas delivery fee: ${value}`);

  const tx = await source.mockIntegration[
    "sendMessageWithForwardedResponse(bytes,bytes,uint16,uint32,uint128)"
  ](
    payload1,
    payload2,
    target.chainId,
    REASONABLE_GAS_LIMIT_FORWARDS,
    valueNeededOnTargetChain,
    { value: value, gasLimit: REASONABLE_GAS_LIMIT }
  );
  console.log(`Sent delivery request! Transaction hash ${tx.hash}`);
  await tx.wait();
  console.log("Message confirmed!");

  return tx.wait();
};

describe("Wormhole Relayer Tests", () => {
  test("Executes a Delivery Success", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload);

    await waitForRelay();

    console.log("Checking status using SDK");
    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Delivery Success");

    console.log("Checking if message was relayed");
    const message = await target.mockIntegration.getMessage();
    expect(message).toBe(arbitraryPayload);
  });

  test("Executes a Delivery Success With Additional VAAs", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);

    const wormhole = Implementation__factory.connect(
      CONTRACTS[network][sourceChain].core || "",
      source.wallet
    );
    const deliverySeq = await wormhole.nextSequence(source.wallet.address);
    const msgTx = await wormhole.publishMessage(0, arbitraryPayload, 200);
    await msgTx.wait();

    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT * 2,
      optionalParams
    );
    console.log(`Quoted gas delivery fee: ${value}`);

    const tx = await source.mockIntegration.sendMessageWithAdditionalVaas(
      [],
      target.chainId,
      REASONABLE_GAS_LIMIT * 2,
      0,
      [
        relayer.createVaaKey(
          source.chainId,
          Buffer.from(tryNativeToUint8Array(source.wallet.address, "ethereum")),
          deliverySeq
        ),
      ],
      { value }
    );

    console.log(`Sent tx hash: ${tx.hash}`);

    const rx = await tx.wait();

    await waitForRelay();

    console.log("Checking status using SDK");
    const status = await getStatus(tx.hash);
    expect(status).toBe("Delivery Success");

    console.log("Checking if message was relayed");
    const message = (await target.mockIntegration.getDeliveryData())
      .additionalVaas[0];
    const parsedMessage = await wormhole.parseVM(message);
    expect(parsedMessage.payload).toBe(arbitraryPayload);
  });

  test("Executes a Delivery Success with manual delivery", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);

    const deliverySeq = await Implementation__factory.connect(
      CONTRACTS[network][sourceChain].core || "",
      source.provider
    ).nextSequence(source.wormholeRelayerAddress);

    console.log(`Got delivery seq: ${deliverySeq}`);
    const rx = await testSend(arbitraryPayload);

    await sleep(1000);

    const rpc = getGuardianRPC(network, ci);
    const emitterAddress = Buffer.from(
      tryNativeToUint8Array(source.wormholeRelayerAddress, "ethereum")
    );
    const deliveryVaa = await getSignedVAAWithRetry(
      [rpc],
      source.chainId,
      emitterAddress.toString("hex"),
      deliverySeq.toBigInt().toString(),
      { transport: NodeHttpTransport() }
    );

    console.log(`Got delivery VAA: ${deliveryVaa}`);
    const deliveryRx = await deliver(
      deliveryVaa.vaaBytes,
      target.wallet,
      getGuardianRPC(network, ci),
      network
    );
    console.log("Manual delivery tx hash", deliveryRx.transactionHash);
    console.log("Manual delivery tx status", deliveryRx.status);

    console.log("Checking status using SDK");
    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Delivery Success");

    console.log("Checking if message was relayed");
    const message = await target.mockIntegration.getMessage();
    expect(message).toBe(arbitraryPayload);
  });

  test("Executes a Forward Request Success", async () => {
    const arbitraryPayload1 = getArbitraryBytes32();
    const arbitraryPayload2 = getArbitraryBytes32();
    console.log(
      `Sent message: ${arbitraryPayload1}, expecting ${arbitraryPayload2} to be forwarded`
    );

    const rx = await testForward(arbitraryPayload1, arbitraryPayload2);

    await waitForRelay(2);

    console.log("Checking status using SDK");
    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Forward Request Success");

    console.log("Checking if message was relayed");
    const message1 = await target.mockIntegration.getMessage();
    expect(message1).toBe(arbitraryPayload1);

    console.log("Checking if forward message was relayed back");
    const message2 = await source.mockIntegration.getMessage();
    expect(message2).toBe(arbitraryPayload2);
  });

  test("Executes multiple forwards", async () => {
    const arbitraryPayload1 = getArbitraryBytes32();
    const arbitraryPayload2 = getArbitraryBytes32();
    console.log(
      `Sent message: ${arbitraryPayload1}, expecting ${arbitraryPayload2} to be forwarded`
    );
    const valueNeededOnTargetChain1 = await relayer.getPrice(
      targetChain,
      sourceChain,
      REASONABLE_GAS_LIMIT,
      optionalParamsTarget
    );
    const valueNeededOnTargetChain2 = await relayer.getPrice(
      targetChain,
      targetChain,
      REASONABLE_GAS_LIMIT,
      optionalParamsTarget
    );

    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT_FORWARDS,
      {
        receiverValue: valueNeededOnTargetChain1.add(valueNeededOnTargetChain2),
        ...optionalParams,
      }
    );
    console.log(`Quoted gas delivery fee: ${value}`);

    const tx =
      await source.mockIntegration.sendMessageWithMultiForwardedResponse(
        arbitraryPayload1,
        arbitraryPayload2,
        target.chainId,
        REASONABLE_GAS_LIMIT_FORWARDS,
        valueNeededOnTargetChain1.add(valueNeededOnTargetChain2),
        { value: value, gasLimit: REASONABLE_GAS_LIMIT }
      );
    console.log("Sent delivery request!");
    await tx.wait();
    console.log("Message confirmed!");

    await waitForRelay(2);

    const status = await getStatus(tx.hash);
    console.log(`Status of forward: ${status}`);

    console.log("Checking if first forward was relayed");
    const message1 = await source.mockIntegration.getMessage();
    expect(message1).toBe(arbitraryPayload2);

    console.log("Checking if second forward was relayed");
    const message2 = await target.mockIntegration.getMessage();
    expect(message2).toBe(arbitraryPayload2);
  });

  testIfDevnet()("Executes a Forward Request Failure", async () => {
    const arbitraryPayload1 = getArbitraryBytes32();
    const arbitraryPayload2 = getArbitraryBytes32();
    console.log(
      `Sent message: ${arbitraryPayload1}, expecting ${arbitraryPayload2} to be forwarded (but should fail)`
    );

    const rx = await testForward(arbitraryPayload1, arbitraryPayload2, true);

    await waitForRelay();

    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Forward Request Failure");

    console.log("Checking if message was relayed (it shouldn't have been!");
    const message1 = await target.mockIntegration.getMessage();
    expect(message1).not.toBe(arbitraryPayload1);

    console.log(
      "Checking if forward message was relayed back (it shouldn't have been!)"
    );
    const message2 = await source.mockIntegration.getMessage();
    expect(message2).not.toBe(arbitraryPayload2);
  });

  testIfDevnet()("Test getPrice in Typescript SDK", async () => {
    const price = await relayer.getPrice(
      sourceChain,
      targetChain,
      200000,
      optionalParams
    );
    expect(price.toString()).toBe("165000000000000000");
  });

  test("Executes a delivery with a Cross Chain Refund", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);
    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT,
      optionalParams
    );
    console.log(`Quoted gas delivery fee: ${value}`);
    const startingBalance = await source.wallet.getBalance();

    const tx = await relayer.sendToEvm(
      source.wallet,
      sourceChain,
      targetChain,
      target.wormholeRelayerAddress, // This is an address that exists but doesn't implement the IWormhole interface, so should result in Receiver Failure
      Buffer.from("hi!"),
      REASONABLE_GAS_LIMIT,
      { value, gasLimit: REASONABLE_GAS_LIMIT },
      optionalParams
    );
    console.log("Sent delivery request!");
    await tx.wait();
    console.log("Message confirmed!");
    const endingBalance = await source.wallet.getBalance();

    await waitForRelay();

    console.log("Checking status using SDK");
    const status = await getStatus(tx.hash);
    expect(status).toBe("Receiver Failure");

    const info = (await relayer.getWormholeRelayerInfo(sourceChain, tx.hash, {
      wormholeRelayerAddresses,
      ...optionalParams,
    })) as relayer.DeliveryInfo;

    await waitForRelay();

    const newEndingBalance = await source.wallet.getBalance();

    console.log("Checking status of refund using SDK");
    console.log(relayer.stringifyWormholeRelayerInfo(info));
    const statusOfRefund = await getStatus(
      info.targetChainStatus.events[0].transactionHash || "",
      targetChain
    );
    expect(statusOfRefund).toBe("Delivery Success");

    console.log(`Quoted gas delivery fee: ${value}`);
    console.log(
      `Cost (including gas) ${startingBalance.sub(endingBalance).toString()}`
    );
    const refund = newEndingBalance.sub(endingBalance);
    console.log(`Refund: ${refund.toString()}`);
    console.log(
      `As a percentage of original value: ${newEndingBalance
        .sub(endingBalance)
        .mul(100)
        .div(value)
        .toString()}%`
    );
    console.log("Confirming refund is nonzero");
    expect(refund.gt(0)).toBe(true);
  });

  test("Executes a Receiver Failure", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload, false, true);

    await waitForRelay();

    const message = await target.mockIntegration.getMessage();
    expect(message).not.toBe(arbitraryPayload);

    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Receiver Failure");
  });

  test("Executes a receiver failure and then redelivery through SDK", async () => {
    const arbitraryPayload = getArbitraryBytes32();
    console.log(`Sent message: ${arbitraryPayload}`);

    const rx = await testSend(arbitraryPayload, false, true);

    await waitForRelay();

    const message = await target.mockIntegration.getMessage();
    expect(message).not.toBe(arbitraryPayload);

    console.log("Checking status using SDK");
    const status = await getStatus(rx.transactionHash);
    expect(status).toBe("Receiver Failure");

    const value = await relayer.getPrice(
      sourceChain,
      targetChain,
      REASONABLE_GAS_LIMIT,
      optionalParams
    );

    const info = (await relayer.getWormholeRelayerInfo(
      sourceChain,
      rx.transactionHash,
      { wormholeRelayerAddresses, ...optionalParams }
    )) as relayer.DeliveryInfo;

    console.log("Redelivering message");
    const redeliveryReceipt = await relayer.resend(
      source.wallet,
      sourceChain,
      targetChain,
      network,
      relayer.createVaaKey(
        source.chainId,
        Buffer.from(
          tryNativeToUint8Array(source.wormholeRelayerAddress, "ethereum")
        ),
        info.sourceDeliverySequenceNumber
      ),
      REASONABLE_GAS_LIMIT,
      0,
      await source.wormholeRelayer.getDefaultDeliveryProvider(),
      [getGuardianRPC(network, ci)],
      {
        value: value,
        gasLimit: REASONABLE_GAS_LIMIT,
      },
      { transport: NodeHttpTransport() },
      { wormholeRelayerAddress: source.wormholeRelayerAddress }
    );

    console.log("redelivery tx:", redeliveryReceipt.hash);

    await redeliveryReceipt.wait();

    await waitForRelay();

    console.log("Checking if message was relayed after redelivery");
    const message2 = await target.mockIntegration.getMessage();
    expect(message2).toBe(arbitraryPayload);

    //Can extend this to look for redelivery event
  });

  // GOVERNANCE TESTS

  testIfDevnet()("Governance: Test Registering Chain", async () => {
    const chain = 24;

    const currentAddress =
      await source.wormholeRelayer.getRegisteredWormholeRelayerContract(chain);
    console.log(
      `For Chain ${source.chainId}, registered chain ${chain} address: ${currentAddress}`
    );

    const expectedNewRegisteredAddress =
      "0x0000000000000000000000001234567890123456789012345678901234567892";

    const timestamp = (await source.wallet.provider.getBlock("latest"))
      .timestamp;

    const firstMessage = governance.publishWormholeRelayerRegisterChain(
      timestamp,
      chain,
      expectedNewRegisteredAddress
    );
    const firstSignedVaa = guardians.addSignatures(
      firstMessage,
      guardianIndices
    );

    let tx = await source.wormholeRelayer.registerWormholeRelayerContract(
      firstSignedVaa,
      { gasLimit: REASONABLE_GAS_LIMIT }
    );
    await tx.wait();

    const newRegisteredAddress =
      await source.wormholeRelayer.getRegisteredWormholeRelayerContract(chain);

    expect(newRegisteredAddress).toBe(expectedNewRegisteredAddress);
  });

  testIfDevnet()(
    "Governance: Test Setting Default Relay Provider",
    async () => {
      const currentAddress =
        await source.wormholeRelayer.getDefaultDeliveryProvider();
      console.log(
        `For Chain ${source.chainId}, default relay provider: ${currentAddress}`
      );

      const expectedNewDefaultDeliveryProvider =
        "0x1234567890123456789012345678901234567892";

      const timestamp = (await source.wallet.provider.getBlock("latest"))
        .timestamp;
      const chain = source.chainId;
      const firstMessage =
        governance.publishWormholeRelayerSetDefaultDeliveryProvider(
          timestamp,
          chain,
          expectedNewDefaultDeliveryProvider
        );
      const firstSignedVaa = guardians.addSignatures(
        firstMessage,
        guardianIndices
      );

      let tx = await source.wormholeRelayer.setDefaultDeliveryProvider(
        firstSignedVaa
      );
      await tx.wait();

      const newDefaultDeliveryProvider =
        await source.wormholeRelayer.getDefaultDeliveryProvider();

      expect(newDefaultDeliveryProvider).toBe(
        expectedNewDefaultDeliveryProvider
      );

      const inverseFirstMessage =
        governance.publishWormholeRelayerSetDefaultDeliveryProvider(
          timestamp,
          chain,
          currentAddress
        );
      const inverseFirstSignedVaa = guardians.addSignatures(
        inverseFirstMessage,
        guardianIndices
      );

      tx = await source.wormholeRelayer.setDefaultDeliveryProvider(
        inverseFirstSignedVaa
      );
      await tx.wait();

      const originalDefaultDeliveryProvider =
        await source.wormholeRelayer.getDefaultDeliveryProvider();

      expect(originalDefaultDeliveryProvider).toBe(currentAddress);
    }
  );

  testIfDevnet()("Governance: Test Upgrading Contract", async () => {
    const IMPLEMENTATION_STORAGE_SLOT =
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

    const getImplementationAddress = () =>
      source.provider.getStorageAt(
        source.wormholeRelayer.address,
        IMPLEMENTATION_STORAGE_SLOT
      );

    console.log(
      `Current Implementation address: ${await getImplementationAddress()}`
    );

    const wormholeAddress = CONTRACTS[network][sourceChain].core || "";

    const newWormholeRelayerImplementationAddress = (
      await new ethers_contracts.WormholeRelayer__factory(source.wallet)
        .deploy(wormholeAddress)
        .then((x) => x.deployed())
    ).address;

    console.log(`Deployed!`);
    console.log(
      `New core relayer implementation: ${newWormholeRelayerImplementationAddress}`
    );

    const timestamp = (await source.wallet.provider.getBlock("latest"))
      .timestamp;
    const chain = source.chainId;
    const firstMessage = governance.publishWormholeRelayerUpgradeContract(
      timestamp,
      chain,
      newWormholeRelayerImplementationAddress
    );
    const firstSignedVaa = guardians.addSignatures(
      firstMessage,
      guardianIndices
    );

    let tx = await source.wormholeRelayer.submitContractUpgrade(firstSignedVaa);

    expect(
      ethers.utils.getAddress((await getImplementationAddress()).substring(26))
    ).toBe(ethers.utils.getAddress(newWormholeRelayerImplementationAddress));
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(() => r(), ms));
}
