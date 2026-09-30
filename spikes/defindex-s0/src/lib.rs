#![no_std]
//! S0 spike: trial contract proving DeFindex venue reachability via contract self-auth.
//! Throwaway code — only moves its own funds between itself and one vault.
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, symbol_short,
    token::TokenClient,
    Address, Env, IntoVal, String, Symbol, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Vault,
    Token,
}

#[contract]
pub struct DefindexS0;
/// Mirror of DeFindex `common::models::Strategy` (field names/order must match).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S0Strategy {
    pub address: Address,
    pub name: String,
    pub paused: bool,
}

/// Mirror of DeFindex `common::models::AssetStrategySet`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S0AssetStrategySet {
    pub address: Address,
    pub strategies: Vec<S0Strategy>,
}

/// Mirror of DeFindex `vault::models::StrategyAllocation`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S0StrategyAllocation {
    pub strategy_address: Address,
    pub amount: i128,
    pub paused: bool,
}

/// Mirror of DeFindex `vault::models::CurrentAssetInvestmentAllocation`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S0CurrentAssetInvestmentAllocation {
    pub asset: Address,
    pub total_amount: i128,
    pub idle_amount: i128,
    pub invested_amount: i128,
    pub strategy_allocations: Vec<S0StrategyAllocation>,
}


const APPROVE_TTL: u32 = 200;

#[contractimpl]
impl DefindexS0 {
    pub fn __constructor(e: Env, vault: Address, token: Address) {
        e.storage().instance().set(&DataKey::Vault, &vault);
        e.storage().instance().set(&DataKey::Token, &token);
        e.storage().instance().extend_ttl(100, 1000);
    }

    fn vault(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Vault).unwrap()
    }

    fn token(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Token).unwrap()
    }

    /// Deposit `amount` of token into the vault as `from = self`.
    /// mode 0 = plain call; 1 = approve-then-plain (allowance probe);
    /// 2 = authorize_as_current_contract([token.transfer(self->vault)]) then call.
    /// Returns (amounts_in, shares_minted).
    pub fn deposit(e: Env, amount: i128, tol_bps: u32, invest: bool, mode: u32) -> (Vec<i128>, i128) {
        let vault = Self::vault(&e);
        let token = Self::token(&e);
        let me = e.current_contract_address();
        let min = amount * (10_000 - tol_bps as i128) / 10_000;
        let desired: Vec<i128> = Vec::from_array(&e, [amount]);
        let mins: Vec<i128> = Vec::from_array(&e, [min]);

        if mode == 1 {
            let exp = e.ledger().sequence() + APPROVE_TTL;
            TokenClient::new(&e, &token).approve(&me, &vault, &amount, &exp);
        } else if mode == 2 {
            e.authorize_as_current_contract(Vec::from_array(
                &e,
                [InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: token.clone(),
                        fn_name: Symbol::new(&e, "transfer"),
                        args: (me.clone(), vault.clone(), amount).into_val(&e),
                    },
                    sub_invocations: Vec::new(&e),
                })],
            ));
        }

        let args: Vec<Val> = (desired, mins, me, invest).into_val(&e);
        let (amounts, shares, _alloc): (Vec<i128>, i128, Val) =
            e.invoke_contract(&vault, &symbol_short!("deposit"), args);
        (amounts, shares)
    }

    /// Read position from inside the contract. Returns
    /// (df_balance, total_supply, per_1e7, per_balance_or_neg1, token_bal, funds_len).
    pub fn read_position(e: Env) -> (i128, i128, i128, i128, i128, u32) {
        let vault = Self::vault(&e);
        let token = Self::token(&e);
        let me = e.current_contract_address();

        let df_bal: i128 = e.invoke_contract(
            &vault,
            &symbol_short!("balance"),
            Vec::from_array(&e, [me.into_val(&e)]),
        );
        let supply: i128 =
            e.invoke_contract(&vault, &Symbol::new(&e, "total_supply"), Vec::new(&e));
        let per_1e7: Vec<i128> = e.invoke_contract(
            &vault,
            &Symbol::new(&e, "get_asset_amounts_per_shares"),
            Vec::from_array(&e, [10_000_000i128.into_val(&e)]),
        );
        let per_bal = if df_bal > 0 {
            let v: Vec<i128> = e.invoke_contract(
                &vault,
                &Symbol::new(&e, "get_asset_amounts_per_shares"),
                Vec::from_array(&e, [df_bal.into_val(&e)]),
            );
            v.get(0).unwrap()
        } else {
            -1
        };
        let funds: Vec<Val> = e.invoke_contract(
            &vault,
            &Symbol::new(&e, "fetch_total_managed_funds"),
            Vec::new(&e),
        );
        let tok_bal = TokenClient::new(&e, &token).balance(&me);
        (df_bal, supply, per_1e7.get(0).unwrap(), per_bal, tok_bal, funds.len())
    }

    /// Withdraw `df_amount` shares to self. mode 0 = plain; 2 = explicit self-auth for
    /// vault.withdraw (fallback probe only). Returns amounts out.
    pub fn withdraw(e: Env, df_amount: i128, tol_bps: u32, mode: u32) -> Vec<i128> {
        let vault = Self::vault(&e);
        let me = e.current_contract_address();
        let expected: Vec<i128> = e.invoke_contract(
            &vault,
            &Symbol::new(&e, "get_asset_amounts_per_shares"),
            Vec::from_array(&e, [df_amount.into_val(&e)]),
        );
        let min = expected.get(0).unwrap() * (10_000 - tol_bps as i128) / 10_000;
        let mins: Vec<i128> = Vec::from_array(&e, [min]);

        if mode == 2 {
            e.authorize_as_current_contract(Vec::from_array(
                &e,
                [InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: vault.clone(),
                        fn_name: Symbol::new(&e, "withdraw"),
                        args: (df_amount, mins.clone(), me.clone()).into_val(&e),
                    },
                    sub_invocations: Vec::new(&e),
                })],
            ));
        }

        let args: Vec<Val> = (df_amount, mins, me).into_val(&e);
        e.invoke_contract(&vault, &symbol_short!("withdraw"), args)
    }

    /// Full struct decode of `get_assets` + `fetch_total_managed_funds` (SDK 22->26 check).
    /// Returns (assets_len, strategies_len_asset0, strategy0_paused, idle, invested, total).
    pub fn read_views(e: Env) -> (u32, u32, bool, i128, i128, i128) {
        let vault = Self::vault(&e);
        let assets: Vec<S0AssetStrategySet> = e.invoke_contract(
            &vault,
            &Symbol::new(&e, "get_assets"),
            Vec::new(&e),
        );
        let funds: Vec<S0CurrentAssetInvestmentAllocation> = e.invoke_contract(
            &vault,
            &Symbol::new(&e, "fetch_total_managed_funds"),
            Vec::new(&e),
        );
        let a0 = assets.get(0).unwrap();
        let s0 = a0.strategies.get(0).unwrap();
        let f0 = funds.get(0).unwrap();
        (
            assets.len(),
            a0.strategies.len(),
            s0.paused,
            f0.idle_amount,
            f0.invested_amount,
            f0.total_amount,
        )
    }
}
