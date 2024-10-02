import {
  Currency,
  CurrencyAmount,
  Percent,
  Token,
  TradeType,
} from "@uniswap/sdk-core";
import {
  Pool,
  Route,
  SwapOptions,
  SwapQuoter,
  SwapRouter,
  Trade,
} from "@uniswap/v3-sdk";
import { ethers } from "ethers";
import JSBI from "jsbi";

import { CurrentConfig, TradeConfig } from "@/config";
import {
  ERC20_ABI,
  QUOTER_CONTRACT_ADDRESS,
  SWAP_ROUTER_ADDRESS,
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE_PER_GAS,
} from "@/lib/constants";
import { getPoolInfo } from "@/lib/pool";
import {
  // getProvider,
  // getWalletAddress,
  sendTransaction,
  TransactionState,
} from "@/lib/providers";
import { fromReadableAmount } from "@/lib/utils";

export type TokenTrade = Trade<Token, Token, TradeType>;

// Trading Functions

export async function createTrade(
  config: TradeConfig,
  inverse = false,
): Promise<TokenTrade> {
  const provider = new ethers.providers.Web3Provider(
    (window as any).ethereum,
    "any",
  );
  const poolInfo = await getPoolInfo(provider);

  const inToken = inverse ? config.tokens.out : config.tokens.in;
  const outToken = inverse ? config.tokens.in : config.tokens.out;

  const pool = new Pool(
    inToken,
    outToken,
    config.tokens.poolFee,
    poolInfo.sqrtPriceX96.toString(),
    poolInfo.liquidity.toString(),
    poolInfo.tick,
  );

  const swapRoute = new Route([pool], inToken, outToken);

  const amountOut = await getOutputQuote(swapRoute);

  const uncheckedTrade = Trade.createUncheckedTrade({
    route: swapRoute,
    inputAmount: CurrencyAmount.fromRawAmount(
      inToken,
      fromReadableAmount(config.tokens.amountIn, inToken.decimals).toString(),
    ),
    outputAmount: CurrencyAmount.fromRawAmount(
      outToken,
      JSBI.BigInt(amountOut).toString(),
    ),
    tradeType: TradeType.EXACT_INPUT,
  });

  return uncheckedTrade;
}

export async function executeTrade(
  trade: TokenTrade,
  config: TradeConfig,
): Promise<TransactionState> {
  if (!config.wallet || !config.account.address || !config.provider) {
    throw new Error("Cannot execute a trade without a connected wallet");
  }

  const walletAddress = config.account.address;

  // Check if the token transfer is approved
  const isApproved = await checkTokenApproval(
    config.tokens.in,
    config.tokens.amountIn,
    walletAddress,
    config.provider,
  );

  // If the token transfer is not approved, approve it
  if (!isApproved) {
    const approval = await getTokenTransferApproval(config);

    if (approval !== TransactionState.Sent) {
      console.error("Token Approval Failed");
      return TransactionState.Failed;
    }
  }
  console.log(`Token ${config.tokens.in.symbol} Approved`);

  const options: SwapOptions = {
    slippageTolerance: new Percent(50, 10_000), // 50 bips, or 0.50%
    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from the current Unix time
    recipient: walletAddress,
  };

  const methodParameters = SwapRouter.swapCallParameters([trade], options);
  console.log("Method Parameters", methodParameters);

  const tx = {
    data: methodParameters.calldata,
    to: SWAP_ROUTER_ADDRESS,
    value: methodParameters.value,
    from: config.wallet.address,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  };

  const res = await sendTransaction(tx, config);

  return res;
}

// Helper Quoting and Pool Functions

async function getOutputQuote(route: Route<Currency, Currency>) {
  const provider = new ethers.providers.Web3Provider(
    (window as any).ethereum,
    "any",
  );

  if (!provider) {
    throw new Error("Provider required to get pool state");
  }

  const { calldata } = SwapQuoter.quoteCallParameters(
    route,
    CurrencyAmount.fromRawAmount(
      CurrentConfig.tokens.in,
      fromReadableAmount(
        CurrentConfig.tokens.amountIn,
        CurrentConfig.tokens.in.decimals,
      ).toString(),
    ),
    TradeType.EXACT_INPUT,
    {
      useQuoterV2: true,
    },
  );

  const quoteCallReturnData = await provider.call({
    to: QUOTER_CONTRACT_ADDRESS,
    data: calldata,
  });

  return ethers.utils.defaultAbiCoder.decode(["uint256"], quoteCallReturnData);
}

export async function checkTokenApproval(
  token: Token,
  amountIn: number,
  address: string,
  provider: any,
): Promise<boolean> {
  if (!provider || !address) {
    console.log("No Provider Found");
    return false;
  }

  try {
    const tokenContract = new ethers.Contract(
      token.address,
      ERC20_ABI,
      provider,
    );

    const allowance = await tokenContract.allowance(
      address,
      SWAP_ROUTER_ADDRESS,
    );

    const status = allowance.gte(fromReadableAmount(amountIn, token.decimals));
    console.log("Allowance", allowance, status);
    return status;
  } catch (e) {
    console.error(e);
    return false;
  }
}

export async function getTokenTransferApproval(
  config: TradeConfig,
): Promise<TransactionState> {
  const provider = config.provider; //getProvider();
  const address = config.account.address; //getWalletAddress();
  if (!provider || !address) {
    console.log("getTokenTransferApproval :: No Provider Found");
    return TransactionState.Failed;
  }

  try {
    const tokenContract = new ethers.Contract(
      config.tokens.in.address,
      ERC20_ABI,
      provider,
    );

    const transaction = await tokenContract.populateTransaction.approve(
      SWAP_ROUTER_ADDRESS,
      fromReadableAmount(
        config.tokens.amountIn,
        config.tokens.in.decimals,
      ).toString(),
    );

    return sendTransaction(
      {
        ...transaction,
        from: address,
      },
      config,
    );
  } catch (e) {
    console.error(e);
    return TransactionState.Failed;
  }
}