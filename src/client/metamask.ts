import { createEVMClient } from "@metamask/connect-evm";
import { createMeasure } from "measure-fn";
import { getAddress, isAddress } from "viem";

export type WalletNetwork = {
  chainId: number;
  chainHex: string;
  name: string;
  currency: "ETH";
  rpcUrl: string;
  explorerUrl: string;
};

export type Eip1193Provider = {
  request(input: { method: string; params?: unknown[] | object }): Promise<any>;
  on?(event: string, handler: (...args: any[]) => void): void;
};

type MetaMaskControllerOptions = {
  loadNetwork: () => Promise<WalletNetwork>;
  dapp: {
    name: string;
    url: string;
    iconUrl: string;
  };
  onAccountsChanged?: (address: string | null) => void;
  onDisconnect?: () => void;
  onChainChanged?: () => void;
};

export type MetaMaskConnectResult = {
  address: string | null;
  network: WalletNetwork;
};

const walletMeasure = createMeasure("wallet");

export function normalizeEvmAddress(value: unknown) {
  const text = String(value || "").trim();
  if (!text || !isAddress(text)) return null;
  return getAddress(text);
}

async function ensureChain(provider: Eip1193Provider, network: WalletNetwork) {
  const current = String(
    (await provider.request({ method: "eth_chainId" })) || "",
  ).toLowerCase();
  if (current === network.chainHex.toLowerCase()) return false;

  await walletMeasure.measure(
    {
      start: () => `Switch wallet network → ${network.name}`,
      end: () => ({ chainId: network.chainId }),
    },
    async () => {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: network.chainHex }],
        });
      } catch (cause: any) {
        if (
          Number(cause?.code) !== 4902 &&
          !/unknown chain|unrecognized chain/i.test(
            String(cause?.message || ""),
          )
        )
          throw cause;

        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: network.chainHex,
              chainName: network.name,
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [network.rpcUrl],
              blockExplorerUrls: [network.explorerUrl],
            },
          ],
        });
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: network.chainHex }],
        });
      }
    },
  );
  return true;
}

export function createMetaMaskController(options: MetaMaskControllerOptions) {
  let networkPromise: Promise<WalletNetwork> | null = null;
  let clientPromise: ReturnType<typeof createEVMClient> | null = null;
  let eventsProvider: Eip1193Provider | null = null;

  function getNetwork() {
    if (!networkPromise) {
      networkPromise = walletMeasure.measure(
        {
          start: () => "Load wallet network",
          end: (network) => ({
            name: network.name,
            chainId: network.chainId,
          }),
        },
        options.loadNetwork,
      );
    }
    return networkPromise;
  }

  function getClient() {
    if (!clientPromise) {
      clientPromise = getNetwork().then((network) =>
        createEVMClient({
          dapp: options.dapp,
          api: {
            supportedNetworks: {
              [network.chainHex]: network.rpcUrl,
            },
          },
        }),
      );
    }
    return clientPromise;
  }

  function installEvents(provider: Eip1193Provider) {
    if (eventsProvider === provider || !provider.on) return;
    eventsProvider = provider;

    provider.on("accountsChanged", (accounts: string[] = []) => {
      options.onAccountsChanged?.(normalizeEvmAddress(accounts[0] || null));
    });
    provider.on("disconnect", () => {
      options.onDisconnect?.();
    });
    provider.on("chainChanged", () => {
      options.onChainChanged?.();
    });
  }

  async function connect(interactive: boolean): Promise<MetaMaskConnectResult> {
    return walletMeasure.measure(
      {
        start: () =>
          interactive ? "Connect MetaMask" : "Restore MetaMask session",
        end: (result) => ({
          interactive,
          connected: Boolean(result.address),
          chainId: result.network.chainId,
        }),
      },
      async () => {
        const network = await getNetwork();
        const client = await getClient();
        const provider = client.getProvider() as Eip1193Provider;
        installEvents(provider);

        let accounts: string[] = [];
        if (interactive) {
          const result = await client.connect({ chainIds: [network.chainHex] });
          accounts = Array.isArray(result?.accounts) ? result.accounts : [];
          await ensureChain(provider, network);
        } else {
          const existing = await provider.request({
            method: "eth_accounts",
            params: [],
          });
          accounts = Array.isArray(existing) ? existing : [];
        }

        return {
          address: normalizeEvmAddress(accounts[0] || null),
          network,
        };
      },
    );
  }

  return {
    connect,
    getNetwork,
  };
}
