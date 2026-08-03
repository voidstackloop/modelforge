mod audit;

// Re-exported so lib.rs's #[napi] functions (already defined directly in
// audit.rs via napi-derive) are picked up by the crate — this module only
// exists to keep store-related code out of a single oversized lib.rs, per
// the migration brief's own module-layout rule.
