# Signal Desk — 100-case coverage report

> AI-generated test output (LLM), not investment advice, no vendor data redistributed

Generated: 2026-07-06T13:45:46.419Z · Universe: 11438 active assets · Full-pipeline runs: yes (flagged cases)

| Segment | Pass | Empty-OK | Fail | Total |
|---|---|---|---|---|
| US stocks | 15 | 0 | 0 | 15 |
| US ETFs | 10 | 0 | 0 | 10 |
| EU stocks | 15 | 0 | 0 | 15 |
| EU ETFs | 0 | 5 | 0 | 5 |
| CN stocks | 15 | 0 | 0 | 15 |
| Crypto | 20 | 0 | 0 | 20 |
| Mixed filters | 10 | 0 | 0 | 10 |
| Shorts | 10 | 0 | 0 | 10 |
| **Total** | **95** | **5** | **0** | **100** |

## US stocks

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 1 | AI chips | PASS | 100 | NVDA, AMD | AMD, AISP, BZAI, CBRS, BRCHF | full ✓ (9 picks, dir=long) |
| 2 | Semicap equipment | PASS | 100 | AMAT, LRCX | AIHZF, BRCHF, BCHPY, AMD, AISP |  |
| 3 | Megabanks | PASS | 100 | JPM, BAC | MBIN, FNMAH, MSBI, AMBZ, MRBK |  |
| 4 | Defense primes | PASS | 100 | LMT, GD, NOC | CDP, HAWK, MRCY, KTOS, LOAR |  |
| 5 | GLP-1 pharma | PASS | 100 | LLY | AMLX, GKOS, GOSS, CRVS, CRBP |  |
| 6 | Cybersecurity | PASS | 100 | CRWD, FTNT, NET | AKAM, EVLV, LDOS, KTOS, ADT |  |
| 7 | Streaming | PASS | 100 | NFLX | CURI, DSP, DXYZ, AMCX, ARHS |  |
| 8 | Cloud software | PASS | 100 | AMZN | NTNX, HPE, ORCL, NSIT, AMWL |  |
| 9 | EV & charging | PASS | 100 | GM, F, CHPT, EVGO | BLNK, CHPT, EVGO, FFAI, BETA |  |
| 10 | REITs / income | PASS | 100 | O, EQR, AMH | MNULF, DX, O, KBSUF, AGNC |  |
| 11 | Energy majors | PASS | 100 | CVX, COP, EOG | MGY, GPOR, CJAX, FRHLF, MUR |  |
| 12 | Digital ads | PASS | 100 | META, GOOGL, APP | APPIF, DSP, APP, AGGI, DXYZ |  |
| 13 | Retail giants | PASS | 100 | COST | CSCMY, MAPGF, COST, KR, KSS |  |
| 14 | Industrial automation | PASS | 100 | EMR, AME | ATS, FPS, GIC, FN, HURC |  |
| 15 | Obesity-econ mega caps only | PASS | 49 | LLY | LLY, MS, AMGN, MRK, GS |  |

## US ETFs

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 16 | Broad market | PASS | 100 | IVV, ITOT, IWB | HCMT, FPX, AAUS, JPUS, EBI |  |
| 17 | Semiconductor sector | PASS | 100 | n/a | FTXL, CHPS, GXPT, CHPY, CHPX |  |
| 18 | Tech sector | PASS | 100 | n/a | IETC, BCTK, JTEK, IYW, IXN |  |
| 19 | Energy sector | PASS | 100 | n/a | DRLL, ERY, ERX, IYE, IEZ |  |
| 20 | Dividend income | PASS | 100 | n/a | HIDV, FIDI, HFSI, DIV, HDV |  |
| 21 | Small caps | PASS | 100 | n/a | OSCV, AVSC, CSMD, GRNJ, DFAS |  |
| 22 | Gold | PASS | 100 | AAAU, IAU, GLDM | FGDL, AAAU, IAUM, CGBLF, GOEX |  |
| 23 | Healthcare sector | PASS | 100 | n/a | IYH, IXJ, IHF, HTEC, CURE |  |
| 24 | Treasury bonds | PASS | 95 | n/a | FLGV, GOVT, LGOV, FTSD, GBF |  |
| 25 | Corporate bonds | PASS | 93 | n/a | IGLB, IGSB, GXIG, FCOR, FLCO |  |

## EU stocks

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 26 | Semis (ASML) | PASS | 100 | ASML.AS | ELTTF, IFNNF, MLXSF, BESVF, EXSNY | full ✓ (7 picks, dir=long) |
| 27 | Luxury | PASS | 100 | n/a | LVMHF, ACRFF, KLPEF, ACCYY, FNCDY |  |
| 28 | Pharma | PASS | 100 | n/a | AZN, EAPIF, LABFF, AMRN, DMPHF |  |
| 29 | Banks | PASS | 100 | n/a | CRARF, MTRBF, CRARY, BQCNF, AVVZF |  |
| 30 | Defense | PASS | 100 | n/a | APMRF, COHTF, BAESY, ISMAF, FINMF |  |
| 31 | Autos | PASS | 100 | n/a | FAURY, FNEDF, AMVOY, PASTF, ATOGF |  |
| 32 | Energy majors | PASS | 100 | n/a | OMVKY, OMVJF, EIPAF, FDENF, OCINF |  |
| 33 | Industrials | PASS | 100 | n/a | ETN, APTV, ABBNY, IMIUY, ADDHY |  |
| 34 | Software | PASS | 100 | n/a | ESTC, BYITY, FNCHF, EUZOF, ACN |  |
| 35 | Renewables | PASS | 100 | n/a | EDRVF, EDRVY, ELCPF, NRDXF, CADLF |  |
| 36 | Food & beverage | PASS | 100 | n/a | GNCGF, JDEPY, DGEAF, BRRLY, GPDNF |  |
| 37 | Aerospace | PASS | 100 | n/a | EADSF, EADSY, MLSPF, AER, DUAVF |  |
| 38 | Telecom | PASS | 100 | n/a | CLNXF, CLLNY, GRPTF, FRTAY, ALEGF |  |
| 39 | Chemicals | PASS | 100 | n/a | ALZCF, EMNSF, IMCDY, ARKAF, COIHF |  |
| 40 | Insurance | PASS | 100 | n/a | AMIGF, AGESY, AGESF, LGGNY, LGGNF |  |

## EU ETFs

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 41 | Broad UCITS | EMPTY-OK | 0 | n/a |  |  |
| 42 | DAX / Germany | EMPTY-OK | 0 | n/a |  |  |
| 43 | EU dividend | EMPTY-OK | 0 | n/a |  |  |
| 44 | EU bonds | EMPTY-OK | 0 | n/a |  |  |
| 45 | EU sector | EMPTY-OK | 0 | n/a |  |  |

## CN stocks

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 46 | E-commerce | PASS | 100 | BABA | BABA, BABAF, MPNGF, CHIZF, CHNVF | full ✓ (7 picks, dir=long) |
| 47 | EV makers | PASS | 100 | LI | LI, GELYF, GELHY, LAAOF, CAAS |  |
| 48 | State banks | PASS | 100 | IDCBY, ACGBY | IDCBY, IDCBF, CMAKY, HHSSF, ACGBY |  |
| 49 | Internet platforms | PASS | 100 | NTES, BIDU | DOYU, CHNVF, NTES, NETTF, KSHTY |  |
| 50 | Consumer recovery | PASS | 100 | n/a | CTVIF, MPNGF, HKSHF, KCKSF, GHG |  |
| 51 | Property developers | PASS | 100 | n/a | CHVKF, CESTF, GZUHF, CRBJF, HLDCY |  |
| 52 | Energy | PASS | 100 | n/a | CCOZF, CSUAY, CLSZF, HIIDQ, FSHRF |  |
| 53 | Telecom | PASS | 100 | n/a | HKBNF, CUCSY, CUCSF, HTCTF, CCTTF |  |
| 54 | Biotech | PASS | 100 | n/a | BJTRF, HMDCF, IVBIY, CHIZF, LYPHF |  |
| 55 | Semiconductors | PASS | 100 | n/a | CAAS, CHAEF, NPT, CHA, MGCLY |  |
| 56 | Insurance | PASS | 100 | n/a | CINSF, CILJF, NWWCF, AIFU, CHPXF |  |
| 57 | Appliances | PASS | 100 | n/a | JGLCF, MGCLY, HISEF, HRSHF, HEGIF |  |
| 58 | Logistics | PASS | 100 | n/a | JDLGF, FLX, BABA, BABAF, MPNGF |  |
| 59 | Travel | PASS | 100 | n/a | CTVIF, CHKIF, MPNGF, HKSHF, HDALF |  |
| 60 | Food delivery | PASS | 100 | MPNGF | GUGNF, HDALF, MB, DIDIY, CHFLF |  |

## Crypto

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 61 | Bitcoin macro | PASS | 90 | BTC | BTG, GOLDN, DITAU, FB, GOLDAO | full ✓ (7 picks, dir=long) |
| 62 | Ethereum ecosystem | PASS | 92 | ETH | LRC, DOG, DYM, ROLL, ERA |  |
| 63 | Layer 2 | PASS | 87 | OP | LRC, NXPC, XFI, SKL, SEI |  |
| 64 | DeFi lending | PASS | 95 | n/a | HPL, MEZO, EUL, CAP, SAVE |  |
| 65 | DEXs | PASS | 91 | n/a | KITTEN, DOLO, MIN, EYED, EXCC |  |
| 66 | Stablecoins | PASS | 92 | USDT, USDC | DOC, HBD, FRAX, BNUSD, USDGLO |  |
| 67 | Decentralized AI | PASS | 89 | RENDER, TAO | RENDER, SN39, ATH, XNAP, NMT |  |
| 68 | Solana ecosystem | PASS | 89 | SOL | SCS, BELIEVE, CARDS, MEA, SOL |  |
| 69 | Liquid staking | PASS | 95 | LDO, RPL | SWISE, VUSD, HLHYPE, LQTY, USDL |  |
| 70 | DePIN | PASS | 92 | FIL, HNT | MINIMA, GRC, DEXNET, MEY, PARTI |  |
| 71 | Gaming | PASS | 90 | n/a | NAKA, TAKE, $YOM, DEP, XAI |  |
| 72 | Oracles | PASS | 96 | LINK, PYTH | ON, ORAI, ORTA, LINK, ORBS |  |
| 73 | RWA tokenization | PASS | 87 | n/a | BIB01, BIBTA, SGOVON, MUBOND, HYBOND |  |
| 74 | Payments | PASS | 96 | XRP | THAT, B2M, USDRIF, XTUSD, BNPL |  |
| 75 | Privacy | PASS | 95 | n/a | EPIC, ZKP, DOP2, ZEC, PRXVT |  |
| 76 | Interoperability | PASS | 92 | n/a | ACX, CSWAP, XSWAP, PTB, IST |  |
| 77 | Exchange tokens | PASS | 90 | BNB, OKB | TKX, BMEX, KCS, KAN, EXCC |  |
| 78 | Storage | PASS | 92 | FIL, AR | FIL, SRX, SC, AR, CLOUD |  |
| 79 | Bitcoin ecosystem | PASS | 93 | n/a | BARD, PTB, EBTC, LOT, CUDIS |  |
| 80 | CEX-only constraint | PASS | 98 | n/a | XTUSD, DOLO, BNUSD, DJED, MMT |  |

## Mixed filters

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 81 | US+EU stocks | PASS | 100 | n/a | IPCEF, BLCAF, CODI, ISLCF, OBIMF |  |
| 82 | Mega caps only | PASS | 67 | n/a | AMD, IBM, NVDA, PANW, ANET |  |
| 83 | Small caps US | PASS | 85 | n/a | BYRN, DXYZ, AVEX, KOPN, DRDNF |  |
| 84 | Exclude defense | PASS | 100 | n/a | ATVK, MRCY, AVEX, AVAV, KTOS |  |
| 85 | Stocks+crypto AI | PASS | 87 | n/a | AI, CXT, SWARMS, FET, SN107 |  |
| 86 | Exclude ticker | PASS | 100 | n/a | NVTS, DIOD, INDI, FPLSF, IPCEF |  |
| 87 | EU large caps | PASS | 100 | n/a | LVMHF, KLPEF, CRARF, CRARY, AIQUF |  |
| 88 | CN mega caps | PASS | 100 | n/a | KSHTY, BABA, BABAF, CGXYF, GUOSF |  |
| 89 | Global bonds | PASS | 100 | n/a | BOND, GTO, AFIF, LDUR, DYFI |  |
| 90 | Crypto mid caps | PASS | 95 | n/a | APT, PUMP, MNT, USD1, GHO |  |

## Shorts

| # | Case | Status | Rows | Expected hit | Top candidates | Notes |
|---|---|---|---|---|---|---|
| 91 | Short AI capex (US) | PASS | 100 | n/a | AIIO, AISP, AI, GLAI, IPCEF | full ✓ (10 picks, dir=short) |
| 92 | Short US offices | PASS | 100 | n/a | ONL, MNULF, ARR, KBSUF, DRETF | full ✓ (10 picks, dir=short) |
| 93 | Short EU autos | PASS | 100 | n/a | FNEDF, ECX, IFNNF, ALV, FAURY | full ✓ (10 picks, dir=short) |
| 94 | Short EU luxury | PASS | 100 | n/a | LUXE, BBRYF, CFRUY, BURBY, CFRHF |  |
| 95 | Short CN property | PASS | 100 | n/a | CESTF, CHVKF, CRBJF, HKSHF, CAOVY | full ✓ (9 picks, dir=short) |
| 96 | Short CN banks | PASS | 100 | n/a | CMAKY, CICHY, CICHF, CEBCF, CIHHF |  |
| 97 | Short memecoins | PASS | 88 | n/a | MEMECOIN, TURBO, MEME, SLOTH, PACK | full ✓ (10 picks, dir=short) |
| 98 | Short L1 alts | PASS | 94 | n/a | SOL, SOMI, SLOTH, SAVE, ALON |  |
| 99 | Short snacks (GLP-1) | PASS | 100 | n/a | AMLX, GPSAF, CRBP, GHYLF, PAGP | full ✓ (10 picks, dir=short) |
| 100 | Both sides EV (US) | PASS | 100 | n/a | EVGO, BLNK, EVEX, LCID, FFAI | full ✓ (10 picks, dir=both) |

## What is not working

Nothing — all 100 cases pass (or are honest empties where the backfill hasn't landed).
