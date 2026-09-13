# Crew AI

A crew of AI agents that pay per call in USDC. Each agent has its own ENS name and a budget it cannot raise, and every reply shows what it cost.

```bash
npm install -g crew-ai
crew-ai
```

Then open http://127.0.0.1:8800.

## What happens when you start it

1. **Unlock your crew.** Connect a wallet (email, browser wallet or WalletConnect) and sign twice. Your crew's key is derived from that signature, so signing with the same wallet on any computer gives you the same crew back — there is nothing to back up.
2. **Choose your name.** Claim `you.crewai.eth`, owned by your wallet. Every agent you hire is named beneath it.
3. **Fund it.** Send USDC on Arc testnet to your crew's address; it is deposited into Circle Gateway automatically.
4. **Hire agents and give them tasks.** Each one spends from its own budget, enforced by the runtime that holds the key.

Organizations can invite members by their Crew name, and members get a name under the organization's own `.eth` name.

## Requirements

- Node.js 20 or newer
- A wallet you can sign with (Privy handles email login if you do not have one)

This runs on **testnets** — Arc testnet for payments and Sepolia for ENS names. Keep working money in it, not savings.

## Configuration

| Variable | Default | |
|---|---|---|
| `CREW_PORT` | `8800` | Port the runtime serves on |
| `CREW_NETWORK` | `eip155:5042002` | Payment network (Arc testnet) |
| `CREW_BACKEND` | the hosted crew backend | Names and organizations |
| `CREW_AUTO_DEPOSIT` | on | Set to `off` to stop auto-depositing into Gateway |
| `EDGEROUTER_HOME` | `~/.edgerouter` | Where the crew's key and data are kept |

`crew-ai --help` lists them too.

## Source

https://github.com/harsh132/crew-ai
