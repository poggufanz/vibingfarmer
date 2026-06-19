#![no_std]
mod contract;
mod test;
pub use contract::*;

#[cfg(test)]
mod integration_test;

#[cfg(test)]
mod seam_test;
