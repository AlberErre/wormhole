// This module provides logic to capture network calls by using 'msw' tool
import { setupServer } from "msw/node";
import { rest } from "msw";
import { Request, Response } from "./types";
import {
  aptosRequestHandler,
  evmRequestHandler,
  genericRequestHandler,
  solanaRequestHandler,
} from "./handlers";
import { NETWORKS } from "../../../src/consts";

let requests: Request[] = [];
let responses: Response[] = [];

const evmHandlers = [
  "ethereum",
  "acala",
  "arbitrum",
  "aurora",
  "avalanche",
  "bsc",
  "celo",
  "fantom",
  "gnosis",
  "karura",
  "klaytn",
  "moonbeam",
  "oasis",
  "optimism",
  "polygon",
].map((chain) => {
  // @ts-ignore
  const rpc = NETWORKS["MAINNET"][chain].rpc;
  return rest.post(rpc, evmRequestHandler);
});

//NOTE: Capture all network traffic
const handlers = [
  // Interceptors
  ...evmHandlers,
  rest.post(NETWORKS["TESTNET"]["solana"].rpc, solanaRequestHandler),
  rest.post(
    `${NETWORKS["TESTNET"]["aptos"].rpc}/transactions/simulate`,
    aptosRequestHandler
  ),
  rest.post(
    `${NETWORKS["TESTNET"]["aptos"].rpc}/transactions`,
    aptosRequestHandler
  ),

  // Loggers
  rest.get("*", genericRequestHandler),
  rest.post("*", genericRequestHandler),
  rest.put("*", genericRequestHandler),
  rest.patch("*", genericRequestHandler),
];

const server = setupServer(...handlers);

export { server, requests, responses };
