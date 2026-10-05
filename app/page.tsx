import Script from 'next/script';

// Dino, the FAQ helper mascot: a sauropod facing left, built from layered
// radial gradients plus rim light and ambient occlusion for a soft 3D look.
// Grouped into shadow / tail / body / neck+head so CSS can idle-animate each
// part independently. gid keeps gradient ids unique per instance.
function DinoSvg({ gid }: { gid: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="dino-svg">
      <defs>
        <radialGradient id={`${gid}-body`} cx="34%" cy="22%" r="90%">
          <stop offset="0%" stopColor="#c8e8c0" />
          <stop offset="40%" stopColor="#8db888" />
          <stop offset="75%" stopColor="#5c8556" />
          <stop offset="100%" stopColor="#39592f" />
        </radialGradient>
        <radialGradient id={`${gid}-head`} cx="38%" cy="24%" r="95%">
          <stop offset="0%" stopColor="#cfecc7" />
          <stop offset="45%" stopColor="#8db888" />
          <stop offset="100%" stopColor="#4a7043" />
        </radialGradient>
        <radialGradient id={`${gid}-belly`} cx="45%" cy="25%" r="80%">
          <stop offset="0%" stopColor="#e6f3df" />
          <stop offset="60%" stopColor="#b5d5ad" />
          <stop offset="100%" stopColor="#8fb489" />
        </radialGradient>
        <linearGradient id={`${gid}-ao`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="55%" stopColor="#243d1f" stopOpacity="0" />
          <stop offset="100%" stopColor="#243d1f" stopOpacity=".5" />
        </linearGradient>
      </defs>
      <ellipse className="dino-shadow" cx="31" cy="57.8" rx="15.5" ry="3" fill="rgba(0,0,0,.32)" />
      <g className="dino-bob">
        {/* tail, trailing low to the right */}
        <g className="dino-tail">
          <path
            d="M37.5 45.5 C46 47 54 44 57.5 38.5 C58.2 37.2 57 36.2 55.8 36.9 C50 40.2 44 42.5 37 42 Z"
            fill={`url(#${gid}-body)`}
          />
          <path
            d="M37.5 45.5 C46 47 54 44 57.5 38.5 C58.2 37.2 57 36.2 55.8 36.9 C50 40.2 44 42.5 37 42 Z"
            fill={`url(#${gid}-ao)`}
          />
        </g>
        {/* back leg and foot */}
        <rect x="35.8" y="43" width="7" height="11" rx="3.4" fill={`url(#${gid}-body)`} />
        <rect x="35.8" y="43" width="7" height="11" rx="3.4" fill={`url(#${gid}-ao)`} />
        <ellipse cx="37" cy="55.3" rx="5.2" ry="2.7" fill={`url(#${gid}-body)`} />
        <ellipse cx="37" cy="55.3" rx="5.2" ry="2.7" fill={`url(#${gid}-ao)`} opacity=".6" />
        <circle cx="32.6" cy="55" r=".8" fill="#2c4528" />
        <circle cx="34.2" cy="56" r=".8" fill="#2c4528" />
        {/* torso with belly patch */}
        <ellipse cx="32.5" cy="40.5" rx="11.8" ry="11" fill={`url(#${gid}-body)`} />
        <ellipse cx="32.5" cy="40.5" rx="11.8" ry="11" fill={`url(#${gid}-ao)`} />
        <ellipse
          cx="28"
          cy="41.5"
          rx="7"
          ry="8.8"
          fill={`url(#${gid}-belly)`}
          opacity=".95"
          transform="rotate(-8 28 41.5)"
        />
        <circle cx="38" cy="35.5" r="1.6" fill="#39592f" opacity=".7" />
        <circle cx="35" cy="33" r="1.3" fill="#39592f" opacity=".7" />
        <circle cx="39.5" cy="39" r="1.1" fill="#39592f" opacity=".5" />
        <ellipse cx="31" cy="32" rx="5.5" ry="2.4" fill="#fff" opacity=".2" />
        {/* rim light along the back */}
        <path
          d="M40 33 C43 36 44 40 43.5 44"
          stroke="#dff0d8"
          strokeWidth="1.2"
          strokeLinecap="round"
          fill="none"
          opacity=".25"
        />
        {/* front leg and foot */}
        <rect x="24" y="43" width="7" height="11" rx="3.4" fill={`url(#${gid}-body)`} />
        <rect x="24" y="43" width="7" height="11" rx="3.4" fill={`url(#${gid}-ao)`} opacity=".5" />
        <ellipse cx="25" cy="55.5" rx="5.2" ry="2.7" fill={`url(#${gid}-body)`} />
        <ellipse cx="25" cy="55.5" rx="5.2" ry="2.7" fill={`url(#${gid}-ao)`} opacity=".5" />
        <circle cx="20.6" cy="55.2" r=".8" fill="#2c4528" />
        <circle cx="22.3" cy="56.1" r=".8" fill="#2c4528" />
        {/* tiny arm over the belly */}
        <path
          d="M26.5 36.5 C23 37.5 21.8 40.5 22.8 43.3 C23.9 44.3 25.6 43.8 25.8 42.4 C25.4 40.3 26.6 38.6 29 38 Z"
          fill={`url(#${gid}-body)`}
        />
        <circle cx="22.7" cy="44" r=".7" fill="#2c4528" />
        <circle cx="24.3" cy="44.3" r=".7" fill="#2c4528" />
        {/* big head on shoulders, facing left */}
        <g className="dino-neck">
          <path
            d="M19 22 C18 28 20 33 24 35.5 C27 36.5 30.5 35 31 31.5 C31.5 27 29 23 25 21.5 Z"
            fill={`url(#${gid}-body)`}
          />
          <ellipse cx="24.5" cy="13.5" rx="11.3" ry="9.8" fill={`url(#${gid}-head)`} />
          <ellipse cx="12.5" cy="16" rx="7" ry="5" fill={`url(#${gid}-head)`} />
          <ellipse cx="24.5" cy="13.5" rx="11.3" ry="9.8" fill={`url(#${gid}-ao)`} opacity=".45" />
          {/* lower jaw, mouth opening and teeth */}
          <ellipse cx="14" cy="21.5" rx="7.6" ry="4.2" fill={`url(#${gid}-belly)`} opacity=".95" />
          <path
            d="M7 18.5 C11 22.5 18 23.5 24.5 21 C21.5 25.5 12.5 26 8.2 22 C7.4 20.9 7 19.6 7 18.5 Z"
            fill="#22301c"
          />
          <path
            d="M9.1 19.9 L10 21.9 L11.2 20.4 L13.1 22.5 L14.4 20.9 L16.1 22.9 L17.6 21.2 L19.3 22.6 L20.9 20.9 L21.9 21.7 L22.9 20.4 C18 22.3 12.5 21.9 9.1 19.9 Z"
            fill="#f4f8f0"
          />
          <ellipse cx="8.9" cy="13.6" rx="1" ry=".55" fill="#2c4528" transform="rotate(-20 8.9 13.6)" />
          {/* dome sheen, eyebrow, big eye, cheek blush */}
          <ellipse cx="21" cy="7.5" rx="4.2" ry="2" fill="#fff" opacity=".32" />
          <path
            d="M21.5 5.8 Q26.5 3.8 31.2 6.4"
            stroke="#1c231e"
            strokeWidth="1.7"
            strokeLinecap="round"
            fill="none"
          />
          <g className="dino-eye">
            <circle cx="26.5" cy="11.5" r="4.6" fill="#fdfefb" />
            <circle cx="25.2" cy="12.2" r="2.9" fill="#1c231e" />
            <circle cx="24.2" cy="10.9" r="1.05" fill="#fff" />
            <circle cx="26.4" cy="13.5" r=".5" fill="#fff" opacity=".8" />
          </g>
          <ellipse cx="32.5" cy="16.5" rx="1.8" ry="1.1" fill="#e8a9a0" opacity=".35" />
        </g>
      </g>
    </svg>
  );
}

export default function Home() {
  return (
    <div className="shell">
      <aside className="sidebar" id="sidebar" aria-label="Main navigation">
        <div className="side-brand">
          <h1>
            SyntheTick<span className="dot">.</span>
            <span className="ver">v0.1</span>
          </h1>
        </div>

        <div className="side-tabs" role="group" aria-label="Workspace">
          <button className="side-tab" id="tabHome" type="button" aria-pressed="true">
            <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              <path d="M9 22V12h6v10" />
            </svg>
            Home
          </button>
          <button className="side-tab" id="tabChat" type="button" aria-pressed="false">
            <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
            </svg>
            Chat
          </button>
        </div>
        <div className="side-note" id="chatNote" hidden>
          Coming soon. After your first research, chat with Dino to go deeper into each company:
          financials, business, technology and more.
        </div>

        <button className="side-new" id="newBtn" type="button">
          <span className="sn-plus" aria-hidden="true">
            +
          </span>
          New research
        </button>

        <nav className="side-nav" aria-label="Sections">
          <button className="side-item" id="navFaq" type="button">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
              FAQ
            </span>
          </button>
          <button className="side-item" id="navRoutine" type="button">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 3v5h-5" />
                <path d="M12 7v5l3 3" />
              </svg>
              Routine
            </span>
          </button>
          <div className="side-note" id="routineNote" hidden>
            Coming soon. Receive a research report automatically on the cadence you choose, on the
            same sector or a different one each time.
          </div>
          <button className="side-item" id="navCompare" type="button">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M12 3v18" />
              </svg>
              Compare
            </span>
          </button>
          <div className="side-note" id="compareNote" hidden>
            Coming soon. Select a set of assets and let the AI generate a report comparing their
            financial data, technologies and businesses.
          </div>
          <a className="side-item" id="navUniverse" href="/universe">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                <path d="m2 12 10 5 10-5" />
                <path d="m2 17 10 5 10-5" />
              </svg>
              Robinhood Universe
            </span>
          </a>
          <button className="side-item" id="navMcp" type="button">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 22v-5" />
                <path d="M9 8V2" />
                <path d="M15 8V2" />
                <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
              </svg>
              MCP
            </span>
          </button>
          <button className="side-item" id="navApi" type="button">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m16 18 6-6-6-6" />
                <path d="m8 6-6 6 6 6" />
              </svg>
              API
            </span>
          </button>
          <button className="side-item" id="settingsBtn" type="button" aria-haspopup="true" aria-expanded="false">
            <span className="si-row">
              <svg className="si-svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 21v-7" />
                <path d="M4 10V3" />
                <path d="M12 21v-9" />
                <path d="M12 8V3" />
                <path d="M20 21v-5" />
                <path d="M20 12V3" />
                <circle cx="4" cy="12" r="2" />
                <circle cx="12" cy="10" r="2" />
                <circle cx="20" cy="14" r="2" />
              </svg>
              Settings
            </span>
          </button>
        </nav>

        <div className="side-recents">
          <div className="side-label">Recents</div>
          <div id="recentList" />
        </div>

        <div className="side-bottom">
          {/* Shown by sd-auth.js while signed out (sign-in required): reopens the sign-in dialog. */}
          <button className="sp-btn side-signin" id="sideSignIn" type="button" hidden>
            Sign in
          </button>
          <button className="side-user" id="sideUser" type="button" title="Open settings" hidden>
            <span className="user-avatar" id="userInitial" aria-hidden="true" />
            <span className="user-email" id="userEmail" />
            <span className="credit-pill" id="creditPill" hidden title="Credits left today" />
          </button>
        </div>
      </aside>
      <div className="backdrop" id="sideBackdrop" hidden />
        <div
          className="sd-modal"
          id="settingsPop"
          hidden
          role="dialog"
          aria-modal="true"
          aria-labelledby="settingsTitle"
        >
          <div className="sd-modal-card">
            <div className="sd-modal-head">
              <h2 className="sd-modal-title" id="settingsTitle">
                Settings
              </h2>
              <button className="sd-modal-x" id="settingsClose" type="button" aria-label="Close settings">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="sd-modal-body">
              <div className="set-row">
                <span className="set-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                  </svg>
                </span>
                <div className="set-info">
                  <h3 className="set-k">Appearance</h3>
                  <p className="set-d">How SyntheTick looks. Dark is the default.</p>
                </div>
                <div className="seg set-seg" role="group" aria-label="Theme">
                  <button type="button" id="themeDark" aria-pressed="true">
                    Dark
                  </button>
                  <button type="button" id="themeLight" aria-pressed="false">
                    Light
                  </button>
                </div>
              </div>
              <div className="set-row">
                <span className="set-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <ellipse cx="12" cy="5" rx="8" ry="3" />
                    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
                    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
                  </svg>
                </span>
                <div className="set-info">
                  <h3 className="set-k">Credits</h3>
                  <p className="set-d" id="creditsVal">
                    Usage tracking coming soon
                  </p>
                  <div className="credit-meter" id="creditMeter" hidden>
                    <div className="cm-bar">
                      <div className="cm-fill" id="creditFill" />
                    </div>
                    <span className="cm-label" id="creditLabel" />
                  </div>
                </div>
              </div>
              <div className="set-row">
                <span className="set-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21a8 8 0 0 1 16 0" />
                  </svg>
                </span>
                <div className="set-info">
                  <h3 className="set-k">Account</h3>
                  <p className="set-d" id="acctLine">
                    Manage your SyntheTick session.
                  </p>
                </div>
                <div className="set-actions">
                  <button className="sp-btn" id="signOutBtn" type="button" hidden>
                    Sign out
                  </button>
                  <a className="sp-btn" id="adminLink" href="/admin" hidden>
                    Admin panel
                  </a>
                </div>
              </div>
              <div className="set-row" id="xRow" hidden>
                <span className="set-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M5 4l14 16" />
                    <path d="M19 4L5 20" />
                  </svg>
                </span>
                <div className="set-info">
                  <h3 className="set-k">X account</h3>
                  <p className="set-d" id="xLine">
                    Link your X account to use the SyntheTick bot on X.
                  </p>
                </div>
                <div className="set-actions">
                  <button className="sp-btn" id="xConnectBtn" type="button">
                    Connect X
                  </button>
                  <button className="sp-btn" id="xDisconnectBtn" type="button" hidden>
                    Disconnect
                  </button>
                </div>
              </div>
              <button className="set-row set-open" id="termsOpen" type="button">
                <span className="set-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <path d="M9 13h6" />
                    <path d="M9 17h4" />
                  </svg>
                </span>
                <div className="set-info">
                  <h3 className="set-k">Terms and Conditions</h3>
                  <p className="set-d">
                    How SyntheTick may be used. SyntheTick is a research tool, not financial
                    advice.
                  </p>
                </div>
                <svg className="set-chev" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div
          className="sd-modal"
          id="termsModal"
          hidden
          role="dialog"
          aria-modal="true"
          aria-labelledby="termsTitle"
        >
          <div className="sd-modal-card">
            <div className="sd-modal-head">
              <h2 className="sd-modal-title" id="termsTitle">
                Terms and Conditions
              </h2>
              <button className="sd-modal-x" id="termsClose" type="button" aria-label="Close terms">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="sd-modal-body sd-modal-prose">
              <p className="terms-updated">Beta terms. Last updated 14 July 2026. A fuller version will follow.</p>
              <h3>1. What SyntheTick is</h3>
              <p>
                SyntheTick is a research tool. It reads an investment thesis, screens public
                markets, crypto, pre-IPO companies and prediction markets, and returns a list of
                assets that match the thesis together with the reasoning behind each match. It is
                currently offered as a free beta.
              </p>
              <h3>2. Not financial advice</h3>
              <p>
                <strong>
                  Nothing in SyntheTick is investment advice, a recommendation, an offer or a
                  solicitation to buy or sell any security or other asset.
                </strong>{' '}
                The results are automated research output for information and education only.
                They do not consider your personal financial situation, objectives or risk
                tolerance. SyntheTick is not a broker, dealer or licensed investment advisor and
                no fiduciary relationship is created by using it. Always do your own research and
                consult a licensed financial advisor before making any investment decision. Any
                decision you take, and any resulting gain or loss, is yours alone.
              </p>
              <h3>3. Data and accuracy</h3>
              <p>
                Market data, fundamentals and other figures come from third-party providers and
                may be delayed, incomplete or wrong. Parts of the output are generated by AI
                models and can contain mistakes. Everything is provided as is, without any
                warranty of accuracy, completeness or fitness for a particular purpose. Verify
                every number against a primary source before relying on it.
              </p>
              <h3>4. Uploaded files and sources</h3>
              <p>
                SyntheTick does not store the files you add to a research. PDFs are read
                entirely in your browser and never leave your device. Screenshots and voice
                recordings are sent to our servers only to extract their text: they are processed
                in memory and discarded as soon as the extraction completes. The extracted text
                becomes part of your research prompt, is processed by our AI providers to run the
                research, and stays in your own browser as part of your recent researches, where
                you can delete it at any time. We also keep a copy of the research prompts you
                submit, linked to your account, as described in section 6.
              </p>
              <h3>5. Beta service and credits</h3>
              <p>
                SyntheTick is in open beta. Every account receives a daily allowance of free
                credits. A search costs 1 credit and a PDF report download costs 1 credit.
                Features, limits and availability can change or be withdrawn at any time without
                notice, and the service may be interrupted or discontinued.
              </p>
              <h3>6. Your account</h3>
              <p>
                You sign in with a Google account. We store your email address, your usage counts
                and the research prompts you submit (the text of your thesis, including text
                extracted from your sources) to operate authentication and the credit system and
                to improve SyntheTick. Prompts are deleted together with your account. You are
                responsible for activity that happens under your account. We may suspend accounts
                that abuse the service, attempt to circumvent limits or scrape it
                programmatically.
              </p>
              <h3>7. Limitation of liability</h3>
              <p>
                To the maximum extent permitted by law, SyntheTick and its operators are not
                liable for any loss arising from use of the service, including investment
                losses, lost profits or losses caused by errors, omissions or unavailability.
              </p>
              <h3>8. Changes</h3>
              <p>
                These terms will be updated as the product moves out of beta. Continued use of
                SyntheTick after an update means you accept the new terms.
              </p>
            </div>
          </div>
        </div>

      <div className="main">
        <header className="mobilebar">
          <button
            className="icon-btn menu-btn"
            id="menuBtn"
            type="button"
            aria-label="Open menu"
            aria-expanded="false"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </svg>
          </button>
          <span className="mb-brand">
            SyntheTick<span className="dot">.</span>
          </span>
          <button className="sp-btn mb-signin" id="mbSignIn" type="button" hidden>
            Sign in
          </button>
        </header>

        <main className="feed empty" id="feed">
          <section className="block composer" id="composer">
            <div className="lead">
              <h2>Your thesis. The assets that match it.</h2>
              <p>
                Convinced AI or Ethereum will reshape entire industries? Turn that conviction into a screened
                list of public and pre-IPO stocks, ETFs, crypto and Polymarket bets.
              </p>
            </div>

            <div className="panel">
              <div className="chat-composer">
                <textarea
                  id="doc"
                  aria-label="Investment thesis"
                  placeholder="Add a thesis, an article, a link, a note or a voice recording. SyntheTick reads the investment case and your constraints, screens the market and checks every result against your criteria."
                />
                <div className="composer-toolbar">
                  <div className="composer-left">
                    <input
                      type="file"
                      id="fileInput"
                      accept="application/pdf,image/*,audio/*,video/*"
                      hidden
                    />
                    <div className="add-menu-wrap">
                      <button
                        className="icon-btn add-trigger"
                        id="addMenuBtn"
                        type="button"
                        aria-label="Add files or links"
                        aria-haspopup="menu"
                        aria-expanded="false"
                        title="Add files or links"
                      >
                        +
                      </button>
                      <div className="add-menu" id="addMenu" role="menu" hidden>
                        <button
                          className="menu-item"
                          id="addFileBtn"
                          type="button"
                          role="menuitem"
                          aria-label="Add file"
                        >
                          <span className="menu-ico" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                              <path d="M14 2v6h6" />
                              <path d="M12 18v-6" />
                              <path d="m9 15 3 3 3-3" />
                            </svg>
                          </span>
                          <span>File</span>
                        </button>
                        <button
                          className="menu-item"
                          id="addLinkBtn"
                          type="button"
                          role="menuitem"
                          aria-label="Add link"
                        >
                          <span className="menu-ico" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
                              <path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" />
                            </svg>
                          </span>
                          <span>Link</span>
                        </button>
                      </div>
                    </div>
                    <button
                      className="icon-btn mic-btn"
                      id="recBtn"
                      type="button"
                      aria-label="Record a voice note"
                      title="Record a voice note"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <path d="M12 19v3" />
                      </svg>
                    </button>
                    <button
                      className="icon-btn dice-btn"
                      id="randomBtn"
                      type="button"
                      aria-label="Try a random thesis idea"
                      title="Try a random thesis idea"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" />
                        <circle cx="8.6" cy="8.6" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="15.4" cy="8.6" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="8.6" cy="15.4" r="1.4" fill="currentColor" stroke="none" />
                        <circle cx="15.4" cy="15.4" r="1.4" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                    <span className="file-name" id="fileName" />
                  </div>

                  <div className="composer-right">
                    <div className="model-menu-wrap">
                      <button
                        className="model-trigger"
                        id="modelBtn"
                        type="button"
                        aria-label="Choose a model"
                        aria-haspopup="menu"
                        aria-expanded="false"
                        title="Choose a model"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 3.5 13.8 9 19.5 11 13.8 13 12 18.5 10.2 13 4.5 11 10.2 9Z" />
                        </svg>
                        <span className="model-name">Claude Sonnet 4.6</span>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m6 9.5 6 6 6-6" />
                        </svg>
                      </button>
                      <div className="model-menu" id="modelMenu" role="menu" hidden>
                        <div className="model-menu-label">Model</div>
                        <button
                          className="model-item is-current"
                          id="modelCurrent"
                          type="button"
                          role="menuitemradio"
                          aria-checked="true"
                        >
                          <span>Claude Sonnet 4.6</span>
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        </button>
                        <button className="model-item" type="button" role="menuitemradio" aria-checked="false" disabled>
                          <span>OpenAI GPT 5</span>
                          <span className="soon">Soon</span>
                        </button>
                        <button className="model-item" type="button" role="menuitemradio" aria-checked="false" disabled>
                          <span>Google Gemini 2.5 Pro</span>
                          <span className="soon">Soon</span>
                        </button>
                        <button className="model-item" type="button" role="menuitemradio" aria-checked="false" disabled>
                          <span>xAI Grok 4</span>
                          <span className="soon">Soon</span>
                        </button>
                        <button className="model-item" type="button" role="menuitemradio" aria-checked="false" disabled>
                          <span>DeepSeek V3</span>
                          <span className="soon">Soon</span>
                        </button>
                        <div className="model-note">
                          Model choice is coming soon. Every research runs on Claude Sonnet 4.6 for
                          now.
                        </div>
                      </div>
                    </div>
                    <button
                      className="icon-btn send-btn"
                      id="startBtn"
                      type="button"
                      disabled
                      aria-label="Start research"
                      title="Start research"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 19V5" />
                        <path d="m5 12 7-7 7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <div id="linkWrap" className="link-wrap">
                <div className="link-row">
                  <input
                    id="linkUrl"
                    className="link-input"
                    type="text"
                    aria-label="Link to add"
                    placeholder="Paste an X post, YouTube video or article link"
                  />
                  <button className="pdf-btn" id="linkLoad" type="button">
                    Load
                  </button>
                </div>
              </div>

              <div className="chips source-chips" id="srcChips" />
            </div>

            <div className="ideas">
              <div className="ideas-label">Ideas for you</div>
              <div className="idea-list" id="ideaList" />
            </div>

            <div className="home-disclaimer">
              Disclaimer: SyntheTick is a research and discovery tool. Nothing here is financial
              advice, a recommendation or an offer to buy or sell any asset. Always do your own
              analysis before investing. Read more on the{' '}
              <button className="disc-terms" id="discTerms" type="button">
                Terms &amp; Conditions
              </button>
              .
            </div>
          </section>
        </main>

        {/* FAQ lives off the homepage: shown as its own view via the sidebar FAQ item. */}
        <section className="faq" id="faq" aria-labelledby="faq-title" hidden>
          <div className="faq-heading">
            <h2 id="faq-title">FAQ</h2>
            <p>What SyntheTick covers today, and what is coming next.</p>
          </div>

          <div className="faq-list">
            <details className="faq-item">
              <summary>How does SyntheTick work?</summary>
              <p>
                SyntheTick turns your investment thesis into a structured market screen:
              </p>
              <ol>
                <li>
                  <strong>Add your thesis.</strong> Write an idea directly or provide an article,
                  link, document, or voice note as source material.
                </li>
                <li>
                  <strong>Review the interpretation.</strong> SyntheTick identifies the central
                  investment case, key themes, direction, and any constraints you mentioned, such as
                  asset class, geography, or company size.
                </li>
                <li>
                  <strong>Screen the universe.</strong> It searches the available stocks, ETFs, bond
                  ETFs, crypto assets, selected pre-IPO companies, and prediction markets while
                  enforcing your chosen constraints.
                </li>
                <li>
                  <strong>Rank the matches.</strong> Eligible results are ordered by how closely they
                  align with your thesis, not by whether they are cheap, valuable, or expected to
                  perform well.
                </li>
                <li>
                  <strong>Review the research.</strong> Each result explains the connection to your
                  thesis and displays available market data, risks, venues, and recent developments
                  so you can continue your own analysis.
                </li>
                <li>
                  <strong>Download the report.</strong> At the end of the screen, you can save a PDF
                  report containing your sources, thesis, selected criteria, and matched assets
                  with their financial data and supporting research.
                </li>
              </ol>
            </details>

            <details className="faq-item">
              <summary>What stage is SyntheTick at?</summary>
              <p>
                SyntheTick is currently at v0.1. This early version is mainly designed to test how
                well the service can match assets against your investment thesis and constraints.
                An MCP server and a public API are already available from the sidebar. Future
                versions will introduce a conversational chat mode and other features shaped by
                user feedback.
              </p>
            </details>

            <details className="faq-item">
              <summary>Does SyntheTick provide financial advice?</summary>
              <p>
                No. SyntheTick is a research and discovery tool. It matches the thesis and
                constraints you provide with relevant assets, then shows why each one may fit. It
                does not recommend what to buy or sell, assess suitability, or advise on valuation,
                timing, position size, or risk.
              </p>
              <p>
                For example, if you are bullish on the sports sector, SyntheTick may surface
                sector-focused ETFs and other relevant assets. It explains how they match your
                thesis without recommending them or judging whether they are fairly valued.
              </p>
            </details>

            <details className="faq-item">
              <summary>How is AI used?</summary>
              <p>
                AI is used to understand your thesis, identify its themes and constraints, match it
                with relevant assets, and explain why each result may fit. Some company overviews
                are also written by AI from public sources. Company and asset names, tickers,
                exchanges, prices, market caps, volumes, and charts come from external market data
                providers. They are not generated by AI. When source data is unavailable or cannot
                be shown, SyntheTick shows it as unavailable rather than inventing a value.
              </p>
            </details>

            <details className="faq-item">
              <summary>How does the ranking work?</summary>
              <p>
                Results are ordered by how closely each asset matches your investment thesis and
                selected constraints. A higher ranking means stronger alignment with what you
                described. It does not mean the asset is better, undervalued, less risky, or more
                likely to deliver a return. The ranking organizes research; it is not a valuation or
                recommendation.
              </p>
            </details>

            <details className="faq-item">
              <summary>What does a score of 92 mean compared to a score of 52?</summary>
              <p>
                The score measures how directly an asset expresses your thesis, on an absolute 0
                to 100 scale. An asset at 92 is a very direct expression of what you described:
                the connection is central and explicit. An asset at 52 relates to your thesis more
                partially, for example through one theme or an indirect exposure, so it deserves a
                closer look before you lean on it. Scores of 70 and above read as high alignment,
                40 to 69 as medium, and below 40 as low; picks below 35 are marked as stretch
                ideas, included to give you a starting point when little else clears the bar.
              </p>
              <p>
                The score always compares an asset with your thesis, never with other assets. A 92
                is not a better investment than a 52; it is simply a closer match to what you
                wrote.
              </p>
            </details>

            <details className="faq-item">
              <summary>Which assets can I screen right now?</summary>
              <p>
                SyntheTick currently covers listed stocks and ETFs across the US, Europe, and
                China through HKEX and US-listed ADRs; bond ETFs; crypto traded on centralized and
                decentralized exchanges; a selected pre-IPO company watchlist; and relevant
                Polymarket prediction markets. Coverage depends on the live universe and available
                market data.
              </p>
            </details>

            <details className="faq-item">
              <summary>Which assets are not available yet?</summary>
              <p>
                Individual corporate or government bonds, mainland China A-shares, options,
                futures, and other derivatives are not currently included. Pre-IPO coverage is a
                curated watchlist rather than the full private market. SyntheTick also does not
                connect to a brokerage or execute trades.
              </p>
            </details>

            <details className="faq-item" id="faq-mcp">
              <summary>Is an MCP integration available?</summary>
              <p>
                Yes. SyntheTick runs an MCP server, so assistants and agents powered by Claude or
                other MCP enabled models can send a thesis to SyntheTick and work with its matched
                assets directly inside their own workflows. Open the MCP section in the sidebar for
                the endpoint and connection instructions; you authenticate with an API key created
                in the API section.
              </p>
            </details>

            <details className="faq-item" id="faq-api">
              <summary>Can I access SyntheTick through an API?</summary>
              <p>
                Yes. The public API lets developers submit a thesis and constraints, run a screen
                programmatically, and receive structured matches with their research rationale, plus
                market data where data licences allow it. Open the API section in the sidebar to
                create a key and see the endpoint documentation. Runs spend your normal daily
                credits.
              </p>
            </details>

            <details className="faq-item" id="faq-universe">
              <summary>What is the Robinhood Universe page?</summary>
              <p>
                It is a live explorer of every tokenized stock and ETF on Robinhood Chain: venue
                quotes, Uniswap token prices, TVL and DEX volume, onchain supply and multipliers,
                corporate actions, and, where data licences allow it, SyntheTick&apos;s nightly
                fundamentals for each asset. Open Robinhood Universe in the sidebar to browse it.
                The registry, venue and onchain data it shows are also available programmatically
                through the universe endpoints documented in the API section.
              </p>
            </details>

            <h3 className="faq-sub" id="faq-credits">Credits</h3>

            <details className="faq-item">
              <summary>How does the credit system work?</summary>
              <p>
                Every account receives 10 free credits per day. Running a research costs 1 credit,
                and downloading the PDF report costs 1 credit. Your balance refreshes back to the
                daily amount at midnight UTC, and unused credits do not carry over. If a run
                fails, the credit is returned to your balance.
              </p>
            </details>

            <details className="faq-item">
              <summary>How can I increase my credits?</summary>
              <p>
                Options to increase your daily credits are coming soon. For now, every account
                refreshes to the same daily amount.
              </p>
            </details>
          </div>
        </section>

        <section className="faq" id="apiView" aria-labelledby="api-title" hidden>
          <div className="faq-heading">
            <h2 id="api-title">API</h2>
            <p>
              Run SyntheTick programmatically: submit a thesis with your constraints, stream the
              screen and receive the matched assets with their research rationale.
            </p>
          </div>

          <h3 className="faq-sub">Your API keys</h3>
          <p className="api-note" id="apiKeysNote">
            Loading your keys…
          </p>
          <div className="api-reveal" id="apiKeyReveal" hidden>
            <p>
              Here is your new key. Copy it now: it is shown only once and cannot be recovered
              later.
            </p>
            <div className="api-reveal-row">
              <code id="apiKeyValue"></code>
              <button className="btn-ghost" id="apiKeyCopyBtn" type="button">
                Copy
              </button>
            </div>
          </div>
          <div className="api-create" id="apiKeyCreate" hidden>
            <input
              className="link-input"
              id="apiKeyName"
              aria-label="API key name"
              maxLength={60}
              placeholder="Key name, for example: my laptop"
            />
            <button className="btn-ghost" id="apiKeyCreateBtn" type="button">
              Create key
            </button>
          </div>
          <div className="api-keys" id="apiKeysList"></div>

          <h3 className="faq-sub">Using the API</h3>
          <p className="api-note">
            A key authenticates your requests and spends your normal daily credits: one run costs
            one credit, exactly like a research in the app. If a run fails, the credit is
            returned.
          </p>
          <p className="api-note">
            <strong>POST /v1/screen</strong> starts a research. Send your thesis as text, plus
            optional constraints. The response is a Server Sent Events stream: <code>status</code>{' '}
            lines while the screen runs, a <code>credits</code> update, then one final{' '}
            <code>result</code> event with the matched assets, or an <code>error</code> event.
            Runs usually take one to three minutes.
          </p>
          <pre className="api-code">{`curl -N https://synthetick.org/v1/screen \\
  -H "Authorization: Bearer stk_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "thesis": "European industrial automation will benefit from reshoring.",
    "constraints": { "assets": ["stock", "etf"], "regions": ["eu"] },
    "breadth": "focused"
  }'`}</pre>
          <p className="api-note">
            Constraints are optional and binding: <code>assets</code> from stock, etf, bond,
            crypto, private, polymarket; <code>regions</code> from us, eu, cn, it, other;{' '}
            <code>caps</code> from mega, large, mid, small, micro; <code>breadth</code> is focused
            or diversified. Anything you wrote in the thesis text itself is honored too.
          </p>
          <p className="api-note">
            <strong>POST /v1/assets</strong> reads a piece of content and answers which assets it
            is about. Send text, a link, or both. It answers in seconds and costs 1 credit; a
            failed call returns the credit. This is the light lookup behind the SyntheTick bot on
            X, not the full research pipeline.
          </p>
          <pre className="api-code">{`curl https://synthetick.org/v1/assets \\
  -H "Authorization: Bearer stk_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{ "text": "TSMC just broke ground on a second Arizona fab." }'`}</pre>
          <p className="api-note">
            The response lists each matched asset with its ticker and kind, plus any names the
            content mentioned that are outside the SyntheTick universe. Price, day change and
            market cap are included only where data licences allow API redistribution; when they
            are left out, <code>market_note</code> says so.
          </p>
          <p className="api-note">
            <strong>GET /v1/me</strong> returns the key owner and the credits you have left today.
          </p>
          <pre className="api-code">{`curl https://synthetick.org/v1/me -H "Authorization: Bearer stk_YOUR_KEY"`}</pre>

          <h3 className="faq-sub">Robinhood Chain universe</h3>
          <p className="api-note">
            The <a className="api-link" href="/universe">Robinhood Universe</a> page is served by
            these endpoints. None of them spend credits.
          </p>
          <p className="api-note">
            <strong>GET /v1/universe/robinhood</strong> is the registry: every tokenized asset with
            its symbol, name and verified token contract address on Robinhood Chain. It is public
            reference data, no key required, so execution agents can build swap allowlists from it
            at any time.
          </p>
          <pre className="api-code">{`curl https://synthetick.org/v1/universe/robinhood`}</pre>
          <p className="api-note">
            <strong>GET /v1/universe/robinhood/assets</strong> returns the dataset behind the page
            for all assets: identity (name, kind, sector, region, description, logo), the token
            contract, the live venue quote (bid, ask, day range, halts, shares per token), onchain
            state (multiplier, total supply, oracle price), corporate action events and holders.
            Uniswap DEX data, market cap, 30 day price history, the nightly fundamentals and ETF
            holdings are included only where data licences allow API redistribution; when they
            are left out, <code>market_note</code> says so. Requires an API key; responses are
            cacheable for 5 minutes.
          </p>
          <pre className="api-code">{`curl https://synthetick.org/v1/universe/robinhood/assets \\
  -H "Authorization: Bearer stk_YOUR_KEY"`}</pre>
          <p className="api-note">
            Append a ticker for a single asset, or <code>/chart</code> for its onchain daily price
            history from its Uniswap pool (DEX data, under the same rule):
          </p>
          <pre className="api-code">{`curl https://synthetick.org/v1/universe/robinhood/assets/NVDA \\
  -H "Authorization: Bearer stk_YOUR_KEY"

curl https://synthetick.org/v1/universe/robinhood/assets/NVDA/chart \\
  -H "Authorization: Bearer stk_YOUR_KEY"`}</pre>
          <p className="api-note">
            You can also restrict a research to this universe: pass{' '}
            <code>{`"universe": "robinhood"`}</code> in the constraints of{' '}
            <strong>POST /v1/screen</strong> and every match will be a tokenized asset, with its
            token address included in the result.
          </p>

          <h3 className="faq-sub">Autonomous trading: the Sail reference agent</h3>
          <p className="api-note">
            SyntheTick ships a working reference agent that turns these endpoints into real
            onchain trades. It lives in the repository under <code>sail-agent/</code> and runs a
            complete daily loop on Robinhood Chain: it reads the day&apos;s news about its
            portfolio on X, writes an investment thesis, screens that thesis with{' '}
            <strong>POST /v1/screen</strong> in universe mode, and then buys or sells tokenized
            stocks based on the picks, sized by a user selected risk level (conservative,
            balanced or aggressive, each with a per trade percentage cap and a daily trade
            limit).
          </p>
          <p className="api-note">
            Execution is built on{' '}
            <a className="api-link" href="https://sail.money" target="_blank" rel="noreferrer">
              Sail
            </a>
            , a protocol for onchain separately managed accounts. The capital never sits with the
            agent: it stays in a self custodial Safe the owner controls, and the agent holds a
            separate signing key whose authority is a <strong>mandate</strong>, a set of
            permission contracts registered onchain. The Sail kernel evaluates the mandate on
            every single transaction, fail closed: this agent can only swap between USDG and an
            allowlist of liquid stock tokens, only on the canonical Uniswap V3 router, only up to
            a fixed per trade cap, only with the proceeds returned to the Safe, and only at
            prices within a sanity band read from the token&apos;s own reference pool. Anything
            else is rejected by the chain itself, regardless of what the agent&apos;s code tries.
            The owner can pause dispatch rights or revoke the mandate in one block at any time.
          </p>
          <p className="api-note">
            The SyntheTick API supplies both sides of that design. The public registry,{' '}
            <strong>GET /v1/universe/robinhood</strong>, provides the verified token addresses
            from which the agent builds its swap allowlists and mandate configuration. The
            screen, <strong>POST /v1/screen</strong> with{' '}
            <code>{`"universe": "robinhood"`}</code>, returns picks that each carry their token
            contract, so the agent never resolves tickers on its own: the same allowlist that
            bounds the mandate is the one the research pipeline screens against.
          </p>
          <p className="api-note">
            The agent writes a daily report of what it read, thought and decided, keeps a chain
            reconciled ledger of every fill, and runs either locally or unattended on a weekday
            schedule. The repository&apos;s <code>sail-agent/README.md</code> has the full
            architecture, the onchain bounds, and a step by step go live checklist, including the
            honest limitations of trading thin onchain pools.
          </p>
        </section>

        <section className="faq" id="mcpView" aria-labelledby="mcp-title" hidden>
          <div className="faq-heading">
            <h2 id="mcp-title">MCP</h2>
            <p>
              Connect Claude or any MCP enabled assistant to SyntheTick: send a thesis from your
              own workflow and work with the matched assets right there.
            </p>
          </div>

          <h3 className="faq-sub">Connect</h3>
          <p className="api-note">
            The MCP server lives at <code>https://synthetick.org/mcp</code> (Streamable HTTP). It
            authenticates with the same API keys as the public API: create one in the{' '}
            <button className="api-link" id="mcpToApi" type="button">
              API section
            </button>{' '}
            and send it as a header. For Claude Code:
          </p>
          <pre className="api-code">{`claude mcp add --transport http synthetick https://synthetick.org/mcp \\
  --header "Authorization: Bearer stk_YOUR_KEY"`}</pre>
          <p className="api-note">
            Any other MCP client works the same way: endpoint URL plus the Authorization header.
          </p>

          <h3 className="faq-sub">Tools</h3>
          <p className="api-note">
            <strong>run_screen</strong> screens the market against a thesis with optional binding
            constraints (asset kinds, regions, cap classes, breadth) and returns the matched assets
            with their rationale and analysis, plus market data where data licences allow it. It
            costs 1 credit from your daily
            budget, exactly like a research in the app, and usually takes one to three minutes; the
            assistant sees progress updates while it runs. <strong>get_credits</strong>{' '}
            checks today&apos;s remaining balance and is free.
          </p>
        </section>
      </div>

      <button
        className="dino-fab"
        id="dinoFab"
        type="button"
        aria-label="Ask Dino how SyntheTick works"
        aria-expanded="false"
        title="Ask Dino how SyntheTick works"
      >
        <DinoSvg gid="dfab" />
      </button>
      <div className="dino-panel" id="dinoPanel" hidden>
        <div className="dino-head">
          <span className="dino-avatar">
            <DinoSvg gid="dava" />
          </span>
          <div className="dino-id">
            <div className="dino-name">Dino</div>
            <div className="dino-sub">FAQ helper</div>
          </div>
          <button className="dino-close" id="dinoClose" type="button" aria-label="Close Dino">
            ×
          </button>
        </div>
        <div className="dino-msgs" id="dinoMsgs" aria-live="polite" />
        <div className="dino-chips" id="dinoChips" />
        <form className="dino-inrow" id="dinoForm">
          <input
            id="dinoText"
            type="text"
            placeholder="Ask how SyntheTick works"
            aria-label="Ask Dino a question"
            autoComplete="off"
          />
          <button type="submit">Ask</button>
        </form>
      </div>

      {/* Beta sign-in gate (spec §12): shown by sd-auth.js only when the server
          runs with auth enabled; local dev without SUPABASE_ANON_KEY never sees it. */}
      <section
        className="auth-gate"
        id="authGate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authTitle"
        hidden
      >
        <div className="auth-card">
          <div className="auth-brand">
            SyntheTick<span className="dot">.</span>
          </div>
          <h2 id="authTitle">Research built around your thesis</h2>
          <p className="auth-sub">
            SyntheTick is in open beta. Sign in with your Google account to start screening the
            market against your investment ideas.
          </p>
          <button className="g-btn" id="googleSignIn" type="button">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            Continue with Google
          </button>
          <p className="auth-err" id="authErr" hidden />
          <p className="auth-note">
            Every account gets 10 free credits per day. A search costs 1 credit and a PDF report
            download costs 1 credit. Credits refresh daily.
          </p>
        </div>
      </section>

      <Script src="/sd-auth.js" strategy="afterInteractive" />
      <Script src="/signal-desk.js" strategy="afterInteractive" />
    </div>
  );
}
