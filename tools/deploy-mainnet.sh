#!/usr/bin/env bash
# Deploy Swarm v2.2 to Arc MAINNET (chain 5042) from the deployer in ../.env.
#
#   wsl -d Ubuntu -- bash /mnt/c/.../swarm/tools/deploy-mainnet.sh
#
# Rehearse first against a local fork (nothing is sent to mainnet):
#   RPC=http://127.0.0.1:8545 bash tools/deploy-mainnet.sh
#
# Swarm Pass is deployed with its faucet OFF: on mainnet passes are minted only by
# the owner. MINT_TO / MINT_AMOUNT mint the first supply to the supplier wallet.
# Every step is checked from chain; any failure stops the script.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/../onchain"
envget() { grep -E "^$1=" ../.env | head -1 | cut -d= -f2- | tr -d '\r'; }
die() { echo "ABORT $*"; exit 1; }

KEY="$(envget DEPLOYER_KEY)"; OWNER="$(envget DEPLOYER_ADDRESS)"
RPC=${RPC:-https://rpc.mainnet.arc.io}
MINT_TO=${MINT_TO:-}
MINT_AMOUNT=${MINT_AMOUNT:-0}
GAS="--gas-price 30gwei --priority-gas-price 1gwei"   # Arc drops anything under 20 gwei
REMAP="--remappings @openzeppelin/=node_modules/@openzeppelin/"

[ "$(arc-cast chain-id --rpc-url "$RPC")" = "5042" ] || die "RPC is not Arc mainnet (5042)"
[ "$(arc-cast wallet address --private-key "$KEY")" = "$OWNER" ] || die "DEPLOYER_KEY does not match DEPLOYER_ADDRESS"
BAL=$(arc-cast balance "$OWNER" --rpc-url "$RPC")
echo "deployer $OWNER  balance $(arc-cast from-wei "$BAL") USDC  gas price $(arc-cast gas-price --rpc-url "$RPC") wei"
# 4 contracts + 3 wiring calls + 1 mint ~ 8M gas ~ 0.24 USDC at 30 gwei; demand 1 USDC of headroom.
[ "$(echo "$BAL >= 1000000000000000000" | bc)" = "1" ] || die "deployer needs at least 1 USDC on mainnet"

arc-forge build $REMAP > /dev/null || die "build"

deploy() {  # contract, constructor args...  -> prints the verified address
  local n want code
  n=$(arc-cast nonce "$OWNER" --rpc-url "$RPC") || die "nonce read"
  want=$(arc-cast compute-address "$OWNER" --nonce "$n" | grep -oE '0x[0-9a-fA-F]{40}') || die "compute-address"
  arc-forge create "$1" --rpc-url "$RPC" --private-key "$KEY" --broadcast $GAS $REMAP \
    --constructor-args "${@:2}" > /tmp/swarm-create.log 2>&1 || { grep -vi private /tmp/swarm-create.log | tail -5; die "create $1"; }
  code=$(arc-cast code "$want" --rpc-url "$RPC")
  [ ${#code} -gt 4 ] || die "no code at predicted $want for $1"
  echo "$want"
}
send() {  # to sig args...
  local st
  st=$(arc-cast send "$1" "$2" "${@:3}" --rpc-url "$RPC" --private-key "$KEY" $GAS 2>&1 | grep -E '^status' | awk '{print $2}')
  [ "$st" = "1" ] || die "$2 on $1 (status ${st:-none})"
  echo "  ok  $2"
}
call() { arc-cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" | tr 'A-F' 'a-f'; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }

BLOCK=$(arc-cast block-number --rpc-url "$RPC")
FACTORY=$(deploy contracts/DealFactory.sol:DealFactory "$OWNER") || { echo "$FACTORY"; exit 1; }; echo "DealFactory $FACTORY"
POOL=$(deploy contracts/DemandPool.sol:DemandPool "$FACTORY" "$OWNER") || { echo "$POOL"; exit 1; };   echo "DemandPool  $POOL"
SETTLER=$(deploy contracts/Settler.sol:Settler "$FACTORY" "$POOL" "$OWNER") || { echo "$SETTLER"; exit 1; }; echo "Settler     $SETTLER"
PASS=$(deploy contracts/SwarmPass.sol:SwarmPass false) || { echo "$PASS"; exit 1; };   echo "SwarmPass   $PASS (faucet off)"

echo "wiring"
send "$FACTORY" 'setDemandPool(address)' "$POOL"
send "$FACTORY" 'setSettler(address)' "$SETTLER"
send "$POOL" 'setSettler(address)' "$SETTLER"
if [ -n "$MINT_TO" ] && [ "$MINT_AMOUNT" != "0" ]; then
  echo "minting $MINT_AMOUNT PASS to $MINT_TO"
  send "$PASS" 'mint(address,uint256)' "$MINT_TO" "$MINT_AMOUNT"
fi

echo "verifying from chain"
fail=0
check() { if [ "$2" = "$3" ]; then echo "  pass  $1"; else echo "  FAIL  $1: got $2 want $3"; fail=1; fi; }
addr() { echo "0x${1: -40}"; }
check "factory -> pool"        "$(addr "$(call "$FACTORY" 'demandPool()(address)')")"  "$(lc "$POOL")"
check "factory -> settler"     "$(addr "$(call "$FACTORY" 'settler()(address)')")"     "$(lc "$SETTLER")"
check "pool -> factory"        "$(addr "$(call "$POOL" 'factory()(address)')")"        "$(lc "$FACTORY")"
check "pool -> settler"        "$(addr "$(call "$POOL" 'settler()(address)')")"        "$(lc "$SETTLER")"
check "pool settler set"       "$(call "$POOL" 'settlerSet()(bool)')"                  "true"
check "settler -> factory"     "$(addr "$(call "$SETTLER" 'factory()(address)')")"     "$(lc "$FACTORY")"
check "settler -> pool"        "$(addr "$(call "$SETTLER" 'pool()(address)')")"        "$(lc "$POOL")"
check "factory not paused"     "$(call "$FACTORY" 'paused()(bool)')"                   "false"
check "pass faucet off"        "$(call "$PASS" 'faucetEnabled()(bool)')"               "false"
check "pass decimals 0"        "$(call "$PASS" 'decimals()(uint8)')"                   "0"
for c in "$FACTORY" "$POOL" "$SETTLER" "$PASS"; do
  check "owner of $c"          "$(addr "$(call "$c" 'owner()(address)')")"             "$(lc "$OWNER")"
done
if [ -n "$MINT_TO" ] && [ "$MINT_AMOUNT" != "0" ]; then
  check "PASS minted to $MINT_TO" "$(call "$PASS" 'balanceOf(address)(uint256)' "$MINT_TO" | awk '{print $1}')" "$MINT_AMOUNT"
fi
[ $fail = 0 ] || die "verification failed"
echo "RESULT $FACTORY $POOL $SETTLER $PASS $BLOCK"
