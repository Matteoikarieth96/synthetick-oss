# Oracles (not included)

The Sailor scaffold ships a Uniswap V3 TWAP oracle here. It is omitted from this MIT repository because its
`TickMath` helper is GPL-2.0-or-later upstream (Uniswap v3-core). The SyntheTick agent does not use an oracle:
its swap permission is the oracle-free template.

If you need it, install the scaffold with `npm i -D @sail.money/sailor` and copy `scaffold/.agents/skills/sailor-templates/oracles/` from the package.
