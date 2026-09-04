export function OutsideInterfaceStyles() {
  return (
    <style>{`
      /* Episode history is part of the TV hardware, not neon UI chrome. */
      .episodeCard,
      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live,
      .programShelfSlot,
      .liveCap {
        outline: none !important;
        border-color: rgba(255,255,255,.09) !important;
      }

      .episodeCard,
      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        box-shadow: none !important;
      }

      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        background: rgba(255,255,255,.045) !important;
      }

      .episodeCard::before,
      .episodeCard::after,
      .episodeThumb::before,
      .episodeThumb::after {
        border-color: rgba(255,255,255,.1) !important;
        box-shadow: none !important;
      }

      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        background: rgba(255,255,255,.045) !important;
      }

      .episodeCard::before,
      .episodeCard::after,
      .episodeThumb::before,
      .episodeThumb::after {
        border-color: rgba(255,255,255,.1) !important;
        box-shadow: none !important;
      }

      .episodeCard .episodeThumb,
      .episodeCard.active .episodeThumb,
      .episodeCard.live .episodeThumb,
      .episodeCard.active.live .episodeThumb {
        border-color: rgba(255,255,255,.09) !important;
        outline: none !important;
        box-shadow: inset 0 1px rgba(255,255,255,.035), 0 5px 16px rgba(0,0,0,.18) !important;
        transition: transform 130ms ease, filter 130ms ease, border-color 130ms ease !important;
      }

      .episodeCard:hover .episodeThumb {
        border-color: rgba(255,255,255,.18) !important;
        filter: brightness(1.06);
      }

      .episodeCard.active .episodeThumb {
        border-color: rgba(255,255,255,.28) !important;
        transform: translateY(-1px);
        filter: brightness(1.08) contrast(1.02);
        box-shadow: inset 0 1px rgba(255,255,255,.07), 0 7px 20px rgba(0,0,0,.28) !important;
      }

      .episodeCard > b,
      .episodeCard.active > b,
      .episodeCard.live > b {
        color: rgba(255,255,255,.58) !important;
        text-shadow: none !important;
      }

      .episodeCard.active > b {
        color: rgba(255,255,255,.9) !important;
      }

      .richHoverTooltip {
        position: fixed;
        z-index: 9999;
        width: min(350px, calc(100vw - 20px));
        min-height: 54px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 0;
        padding: 9px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 14px;
        background:
          linear-gradient(180deg, rgba(34,36,43,.96), rgba(13,14,18,.96));
        box-shadow:
          inset 0 1px rgba(255,255,255,.08),
          0 18px 60px rgba(0,0,0,.5),
          0 0 0 1px rgba(0,0,0,.2);
        color: rgba(255,255,255,.94);
        backdrop-filter: blur(22px) saturate(1.2);
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transform: translateY(3px) scale(.985);
        transform-origin: center;
        transition: opacity 110ms ease, transform 110ms ease, visibility 110ms linear;
      }

      .richHoverTooltip.visible {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
      }

      .richHoverTooltip.hasImage {
        grid-template-columns: 112px minmax(0,1fr);
        gap: 10px;
      }

      .richTooltipImage {
        width: 112px;
        height: 70px;
        object-fit: cover;
        border-radius: 9px;
        background: rgba(255,255,255,.035);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
      }

      .richTooltipCopy {
        min-width: 0;
        display: grid;
        align-content: center;
        gap: 5px;
        padding: 1px 2px;
      }

      .richTooltipKicker {
        font: 780 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .11em;
        color: rgba(255,255,255,.52);
      }

      .richTooltipBody {
        white-space: pre-line;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(255,255,255,.94);
      }

      .richTooltipMeta {
        white-space: pre-line;
        overflow-wrap: anywhere;
        font: 650 9px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgba(255,255,255,.46);
      }

      .richHoverTooltip::after {
        content: "";
        position: absolute;
        width: 9px;
        height: 9px;
        background: rgba(22,23,28,.96);
        border: solid rgba(255,255,255,.13);
        transform: rotate(45deg);
      }

      .richHoverTooltip[data-side="left"]::after {
        right: -5px;
        top: calc(50% - 5px);
        border-width: 1px 1px 0 0;
      }

      .richHoverTooltip[data-side="right"]::after {
        left: -5px;
        top: calc(50% - 5px);
        border-width: 0 0 1px 1px;
      }

      .richHoverTooltip[data-side="above"]::after {
        left: calc(50% - 5px);
        bottom: -5px;
        border-width: 0 1px 1px 0;
      }

      .richHoverTooltip[data-side="below"]::after {
        left: calc(50% - 5px);
        top: -5px;
        border-width: 1px 0 0 1px;
      }

      .watchDeck {
        overflow: visible !important;
      }

      .participationBoard {
        width: min(1040px, calc(100vw - 150px));
        margin: 10px auto 0;
        position: relative;
        z-index: 48;
        overflow: visible;
      }

      .participationDock {
        min-height: 46px;
        display: grid;
        grid-template-columns: 34px auto auto minmax(80px, 1fr) auto auto;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        position: relative;
        z-index: 3;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 15px;
        background:
          linear-gradient(180deg, rgba(25,27,32,.9), rgba(10,11,14,.9));
        box-shadow:
          inset 0 1px rgba(255,255,255,.055),
          0 12px 38px rgba(0,0,0,.24);
        backdrop-filter: blur(20px) saturate(1.15);
      }

      .boardToggle,
      .dockIdeaSummary,
      .walletMetric {
        border: 0;
        color: inherit;
        font: inherit;
      }

      .boardToggle {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        padding: 0;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
        color: rgba(255,255,255,.62);
        cursor: pointer;
      }

      .boardToggle:hover,
      .participationBoard.open .boardToggle {
        background: rgba(255,255,255,.075);
        color: rgba(255,255,255,.9);
      }

      .boardToggle svg,
      .participationMeta svg,
      .persistentIdeaForm svg,
      .ownIdeaActions svg,
      .viewerMetric svg,
      .walletMetric svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .boardToggle svg {
        transition: transform 260ms cubic-bezier(.2,.75,.2,1);
      }

      .participationBoard.open .boardToggle svg {
        transform: rotate(180deg);
      }

      .viewerMetric,
      .episodeMetric,
      .walletMetric {
        height: 32px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: rgba(255,255,255,.62);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }

      .viewerMetric,
      .episodeMetric {
        padding: 0 3px;
      }

      .episodeMetric {
        gap: 7px;
      }

      .episodeMetric > strong {
        opacity: .9;
      }

      .dockIdeaSummary {
        min-width: 0;
        height: 32px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 0 10px;
        border-radius: 10px;
        background: rgba(255,255,255,.025);
        color: rgba(255,255,255,.72);
        text-align: left;
        cursor: pointer;
      }

      .dockIdeaSummary:hover {
        background: rgba(255,255,255,.055);
        color: rgba(255,255,255,.92);
      }

      .dockIdeaSummary > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        line-height: 1;
      }

      .dockIdeaSummary > b,
      .dockIdeaSummary > i {
        font: 720 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
        opacity: .58;
        white-space: nowrap;
      }

      .walletMetric {
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 0 8px;
        background: transparent;
        cursor: pointer;
      }

      .walletMetric:hover,
      .walletMetric.connected {
        border-color: rgba(255,255,255,.1);
        background: rgba(255,255,255,.045);
        color: rgba(255,255,255,.86);
      }

      .participationError {
        width: 20px;
        height: 20px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: rgba(255,255,255,.08);
        font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
      }

      .participationSheet {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 8px);
        height: clamp(310px, 48vh, 540px);
        z-index: 2;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.135);
        border-radius: 20px;
        background:
          radial-gradient(circle at 50% 110%, rgba(255,255,255,.04), transparent 42%),
          linear-gradient(180deg, rgba(20,22,27,.955), rgba(8,9,12,.965));
        box-shadow:
          inset 0 1px rgba(255,255,255,.065),
          0 -10px 44px rgba(0,0,0,.24),
          0 28px 80px rgba(0,0,0,.5);
        backdrop-filter: blur(26px) saturate(1.18);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(18px) scale(.985,.94);
        transform-origin: 50% 100%;
        transition:
          opacity 180ms ease,
          transform 320ms cubic-bezier(.16,.84,.24,1),
          visibility 0s linear 320ms;
      }

      .participationBoard.open .participationSheet {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transform: translateY(0) scale(1);
        transition:
          opacity 190ms ease,
          transform 330ms cubic-bezier(.16,.84,.24,1),
          visibility 0s linear 0s;
      }

      .participationColumns {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr);
      }

      .persistentWorld,
      .persistentIdeas {
        min-width: 0;
        min-height: 0;
        padding: 14px;
        overflow: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
      }

      .persistentWorld {
        border-right: 1px solid rgba(255,255,255,.075);
        display: grid;
        align-content: start;
        gap: 8px;
      }

      .worldLocationCard,
      .persistentWorldItems > button {
        width: 100%;
        text-align: left;
        border: 1px solid transparent;
        color: inherit;
        background: rgba(255,255,255,.026);
        cursor: pointer;
      }

      .worldLocationCard {
        display: grid;
        gap: 5px;
        padding: 10px 11px;
        border-radius: 12px;
      }

      .worldLocationCard:hover,
      .persistentWorldItems > button:hover {
        border-color: rgba(255,255,255,.11);
        background: rgba(255,255,255,.055);
      }

      .worldLocationCard > b { font-size: 13px; }
      .worldLocationCard > span {
        font-size: 11px;
        line-height: 1.4;
        opacity: .66;
      }

      .persistentWorldItems {
        display: grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 6px;
      }

      .persistentWorldItems > button {
        display: grid;
        gap: 3px;
        padding: 8px 9px;
        border-radius: 10px;
      }

      .persistentWorldItems > button > b { font-size: 11px; }
      .persistentWorldItems > button > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 10px;
        opacity: .58;
      }

      .persistentWorldItems.props > button { opacity: .86; }

      .persistentThreads {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .persistentThreads > span {
        max-width: 46ch;
        padding: 5px 7px;
        border: 1px solid rgba(255,255,255,.065);
        border-radius: 999px;
        font-size: 9px;
        line-height: 1.25;
        opacity: .58;
      }

      .persistentIdeas {
        display: grid;
        align-content: start;
        gap: 7px;
      }

      .persistentIdeaForm {
        display: grid;
        grid-template-columns: minmax(0,1fr) 38px;
        gap: 7px;
        position: sticky;
        top: 0;
        z-index: 2;
        padding-bottom: 7px;
        background: linear-gradient(180deg, rgba(15,17,21,.98) 68%, rgba(15,17,21,0));
      }

      .persistentIdeaForm > input {
        min-width: 0;
        width: 100%;
        height: 38px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 11px;
        outline: none;
        padding: 0 11px;
        background: rgba(255,255,255,.035);
        color: inherit;
        font: inherit;
        font-size: 12px;
      }

      .persistentIdeaForm > input:focus {
        border-color: rgba(255,255,255,.22);
        background: rgba(255,255,255,.055);
      }

      .persistentIdeaForm > input::placeholder { color: rgba(255,255,255,.27); }

      .persistentIdeaForm > button,
      .ownIdeaActions > button {
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 10px;
        background: rgba(255,255,255,.04);
        color: rgba(255,255,255,.65);
        cursor: pointer;
      }

      .persistentIdeaForm > button {
        width: 38px;
        height: 38px;
        display: grid;
        place-items: center;
      }

      .persistentIdeaForm > button:disabled { opacity: .28; cursor: default; }

      .persistentProposalList {
        display: grid;
        gap: 6px;
      }

      .persistentProposal {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0,1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 9px 10px;
        border: 1px solid transparent;
        border-radius: 11px;
        background: rgba(255,255,255,.03);
      }

      .persistentProposal:hover {
        border-color: rgba(255,255,255,.1);
        background: rgba(255,255,255,.055);
      }

      .persistentProposal.own {
        grid-template-columns: minmax(0,1fr) auto auto;
        border-color: rgba(255,255,255,.11);
        background: rgba(255,255,255,.06);
        cursor: default;
      }

      .persistentProposal.pending { opacity: .45; }

      .persistentProposalText {
        min-width: 0;
        display: grid;
        gap: 3px;
      }

      .persistentProposalText > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .persistentProposalText > i {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 9px;
        font-style: normal;
        opacity: .4;
      }

      .persistentProposal > b {
        font: 760 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        opacity: .78;
      }

      .proposalVote {
        height: 30px;
        min-width: 52px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 0 8px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 9px;
        background: rgba(255,255,255,.045);
        color: rgba(255,255,255,.78);
        cursor: pointer;
      }
      .proposalVote:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,.09);
        border-color: rgba(255,255,255,.18);
      }
      .proposalVote:active { transform: translateY(0); }
      .proposalVote:disabled { opacity: .4; cursor: default; }
      .proposalVote svg { width: 13px; height: 13px; }
      .proposalVote > b {
        font: 760 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .ownIdeaActions { display: flex; gap: 4px; }
      .ownIdeaActions > button {
        width: 27px;
        height: 27px;
        display: grid;
        place-items: center;
      }
      .ownIdeaActions svg { width: 13px; height: 13px; }

      .worldDetailShade {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(0,0,0,.58);
        backdrop-filter: blur(8px);
      }

      .worldDetailModal {
        width: min(520px, 92vw);
        max-height: min(70vh, 620px);
        overflow: auto;
        position: relative;
        display: grid;
        gap: 9px;
        padding: 18px;
        border: 1px solid rgba(255,255,255,.13);
        border-radius: 16px;
        background: rgba(13,14,18,.96);
        box-shadow: 0 30px 90px rgba(0,0,0,.45);
      }

      .worldDetailModal > button {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        background: rgba(255,255,255,.06);
        color: inherit;
        cursor: pointer;
      }

      .worldDetailModal > b { padding-right: 30px; font-size: 15px; }
      .worldDetailModal > p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        opacity: .72;
      }


      /* v12: make the history rail own its vertical space. Removing decorative
         rail children in v11 exposed the old intrinsic-height behavior, which
         could collapse .episodeList to roughly one card. */
      .episodeShelf {
        height: 100dvh !important;
        max-height: 100dvh !important;
        min-height: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
      }

      .episodeShelf > .liveCap {
        flex: 0 0 auto !important;
      }

      .episodeShelf > .episodeList {
        flex: 1 1 0 !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
        overscroll-behavior: contain;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 8px !important;
        padding-bottom: 12px !important;
        scrollbar-width: thin;
      }

      .episodeList > .episodeCard {
        flex: 0 0 auto !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      .episodeList > .programShelfSlot {
        flex: 0 0 66px !important;
        width: 100% !important;
        min-width: 0 !important;
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 24px;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border: 1px solid rgba(255,255,255,.09) !important;
        border-radius: 13px;
        background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012));
        box-shadow: inset 0 1px rgba(255,255,255,.025), 0 5px 18px rgba(0,0,0,.18) !important;
        box-sizing: border-box;
      }

      .programShelfVisual {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        height: 46px;
        border-radius: 9px;
        background: rgba(0,0,0,.32);
        overflow: hidden;
      }

      .programShelfPulse {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: rgba(255,255,255,.42);
        box-shadow: 0 0 0 5px rgba(255,255,255,.025);
      }

      .programShelfSlot.phase-locked .programShelfPulse,
      .programShelfSlot.phase-planning .programShelfPulse,
      .programShelfSlot.phase-rendering .programShelfPulse,
      .programShelfSlot.phase-finalizing .programShelfPulse {
        animation: programShelfBreath 1.15s ease-in-out infinite alternate;
      }

      .programShelfVisual > small {
        position: absolute;
        right: 6px;
        bottom: 4px;
        font-size: 9px;
        opacity: .55;
      }

      .programShelfSlot > b {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        opacity: .7;
        text-align: center;
      }

      @keyframes programShelfBreath {
        from { transform: scale(.9); opacity: .45; }
        to { transform: scale(1.14); opacity: 1; }
      }

      .episodeCard.future {
        opacity: .58;
      }

      /* v12 drawer: one intentional dock row, with the sheet floating upward
         over the set instead of reflowing the TV. */
      .participationBoard {
        width: min(1080px, calc(100vw - 176px));
        margin-top: 14px;
        z-index: 58;
      }

      .participationDock {
        min-height: 48px;
        grid-template-columns: 36px auto minmax(0, 1fr) auto auto auto;
        gap: 9px;
        padding: 6px 9px;
        border-radius: 16px;
        background:
          linear-gradient(180deg, rgba(27,29,34,.94), rgba(11,12,15,.94));
        box-shadow:
          inset 0 1px rgba(255,255,255,.065),
          inset 0 -1px rgba(0,0,0,.32),
          0 10px 34px rgba(0,0,0,.28);
      }

      .viewerMetric,
      .proposalMetric,
      .walletMetric {
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        white-space: nowrap;
        color: rgba(255,255,255,.62);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .viewerMetric,
      .proposalMetric {
        min-width: 40px;
        padding: 0 5px;
      }

      .proposalMetric svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .episodeMetric { display: none !important; }

      .dockIdeaSummary {
        height: 34px;
        padding: 0 12px;
        border: 1px solid rgba(255,255,255,.045);
        background: rgba(255,255,255,.022);
      }

      .dockIdeaSummary:hover {
        border-color: rgba(255,255,255,.095);
      }

      .participationSheet {
        bottom: calc(100% + 10px);
        height: min(64vh, 660px);
        min-height: 370px;
        border-radius: 22px;
        background:
          radial-gradient(circle at 72% 115%, rgba(255,255,255,.05), transparent 42%),
          linear-gradient(180deg, rgba(24,26,31,.975), rgba(8,9,12,.982));
        box-shadow:
          inset 0 1px rgba(255,255,255,.075),
          inset 0 -1px rgba(0,0,0,.5),
          0 -14px 50px rgba(0,0,0,.2),
          0 34px 100px rgba(0,0,0,.58);
        transform: translateY(26px) scale(.988,.93);
      }

      .drawerGrab {
        height: 20px;
        display: grid;
        place-items: center;
        border-bottom: 1px solid rgba(255,255,255,.055);
        background: rgba(255,255,255,.012);
      }

      .drawerGrab > i {
        width: 42px;
        height: 3px;
        border-radius: 999px;
        background: rgba(255,255,255,.15);
      }

      .participationColumns {
        height: calc(100% - 20px);
        grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr);
      }

      .persistentWorld,
      .persistentIdeas {
        padding: 16px;
      }

      .persistentWorld {
        gap: 10px;
        background: linear-gradient(90deg, rgba(255,255,255,.012), transparent 58%);
      }

      .worldLocationCard {
        padding: 13px 14px;
        border-radius: 14px;
        background: rgba(255,255,255,.035);
      }

      .worldLocationCard > b {
        font-size: 14px;
      }

      .worldLocationCard > span {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-size: 11px;
        line-height: 1.45;
      }

      .persistentWorldItems {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 7px;
      }

      .persistentWorldItems > button {
        min-height: 58px;
        align-content: center;
        padding: 10px 11px;
        border-radius: 12px;
        background: rgba(255,255,255,.028);
      }

      .persistentIdeas {
        gap: 9px;
      }

      .persistentIdeaForm {
        grid-template-columns: minmax(0, 1fr) 42px;
        gap: 8px;
        padding-bottom: 10px;
        background: linear-gradient(180deg, rgba(18,20,24,.99) 74%, rgba(18,20,24,0));
      }

      .persistentIdeaForm > input,
      .persistentIdeaForm > button {
        height: 42px;
      }

      .persistentIdeaForm > button {
        width: 42px;
      }

      .persistentProposalList {
        gap: 7px;
      }

      .persistentProposal {
        min-height: 50px;
        padding: 10px 11px;
        border-color: rgba(255,255,255,.035);
        background: rgba(255,255,255,.028);
      }

      .persistentProposal.own {
        border-color: rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
      }

      .persistentProposalText > span {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        line-height: 1.35;
      }

      @media (max-width: 760px) {
        .participationBoard {
          width: min(94vw, 680px);
          margin-top: 8px;
        }

        .participationDock {
          grid-template-columns: 32px auto auto minmax(0,1fr) auto;
          gap: 5px;
          padding-inline: 6px;
        }

        .participationDock > .participationError { display: none; }
        .walletMetric > b { display: none; }
        .dockIdeaSummary { padding-inline: 8px; }

        .participationSheet {
          height: min(68vh, 560px);
          border-radius: 17px;
        }

        .participationColumns {
          display: block;
          overflow: auto;
        }

        .persistentWorld,
        .persistentIdeas {
          overflow: visible;
        }

        .persistentWorld {
          border-right: 0;
          border-bottom: 1px solid rgba(255,255,255,.07);
        }
        .persistentWorldItems { grid-template-columns: 1fr 1fr; }
      }


      /* MEME TV tokens. Legacy pump-* aliases remain only to avoid noisy CSS churn. */
      :root {
        --meme-acid: #c8ff00;
        --meme-acid-hi: #d9ff33;
        --meme-acid-low: #86ad00;
        --meme-ink: #000;
        --meme-panel: #080a07;
        --meme-white: #f7f8f4;

        --pump-gold: var(--meme-acid);
        --pump-gold-hi: var(--meme-acid-hi);
        --pump-gold-low: var(--meme-acid-low);
        --pump-silver: var(--meme-white);
        --pump-silver-dim: #747a70;
        --pump-black: var(--meme-ink);
        --pump-panel: var(--meme-panel);
      }

      .minimalTop .wordmark {
        width: 76px !important;
        height: 76px !important;
        display: block !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        overflow: hidden !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .pumptvLogo {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        filter: drop-shadow(0 5px 14px rgba(0,0,0,.35));
      }

      .statusDot.ready,
      .powerLamp.ready,
      .statusDot.work,
      .powerLamp.work {
        background: var(--pump-gold-hi) !important;
        box-shadow: 0 0 0 1px rgba(200,255,0,.22), 0 0 12px rgba(200,255,0,.28) !important;
      }

      /* These are machined hardware keys now, not glowing arcade knobs. */
      .knobStack {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        gap: 10px !important;
      }
      .knobControl {
        position: relative !important;
        width: 48px !important;
        height: 38px !important;
        min-width: 48px !important;
        min-height: 38px !important;
        padding: 0 !important;
        display: grid !important;
        place-items: center !important;
        border: 1px solid rgba(200,201,203,.25) !important;
        border-radius: 12px !important;
        outline: 0 !important;
        color: rgba(200,201,203,.72) !important;
        background:
          linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.015)),
          #151719 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.09),
          inset 0 -2px rgba(0,0,0,.55),
          0 5px 12px rgba(0,0,0,.25) !important;
        cursor: pointer !important;
        transform: none !important;
      }
      .knobControl:hover {
        border-color: rgba(200,201,203,.42) !important;
        color: var(--pump-silver) !important;
        transform: translateY(-1px) !important;
      }
      .knobControl:active {
        transform: translateY(1px) !important;
        box-shadow: inset 0 2px 5px rgba(0,0,0,.58) !important;
      }
      .knobControl.on {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.48) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.12), rgba(255,255,255,.015)),
          #171713 !important;
      }
      .knobNeedle {
        position: absolute !important;
        top: 4px !important;
        right: 7px !important;
        width: 11px !important;
        height: 2px !important;
        border: 0 !important;
        border-radius: 999px !important;
        background: var(--pump-silver-dim) !important;
        transform: rotate(-48deg) !important;
        transform-origin: right center !important;
        opacity: .38 !important;
        box-shadow: none !important;
      }
      .knobControl.on .knobNeedle {
        background: var(--pump-gold-hi) !important;
        opacity: .95 !important;
      }
      .knobIcon {
        position: relative !important;
        inset: auto !important;
        width: 20px !important;
        height: 20px !important;
        display: grid !important;
        place-items: center !important;
        border: 0 !important;
        background: transparent !important;
      }
      .knobIcon svg {
        width: 19px !important;
        height: 19px !important;
        fill: currentColor !important;
      }
      .knobIcon svg .stroke {
        fill: none !important;
        stroke: currentColor !important;
        stroke-width: 1.7 !important;
      }

      /* Selected != neon border: a small brass play index plus mechanical lift. */
      .episodeCard {
        position: relative !important;
        opacity: .72;
        transition: opacity 140ms ease, transform 140ms ease, background 140ms ease !important;
      }
      .episodeCard:hover { opacity: .9; }
      .episodeCard.active {
        opacity: 1 !important;
        transform: translateX(-2px) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.09), rgba(200,201,203,.025)) !important;
      }
      .episodeCard.active > b::before {
        content: "▶";
        color: var(--pump-gold-hi);
        font-size: 7px;
        margin-right: 4px;
        vertical-align: 1px;
      }
      .episodeCard.live .episodeThumb > em {
        color: var(--pump-gold-hi) !important;
        text-shadow: 0 0 8px rgba(200,255,0,.45) !important;
      }
      .episodeCard.active .episodeThumb {
        border-color: rgba(200,255,0,.32) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.07),
          0 7px 20px rgba(0,0,0,.30),
          -3px 0 0 rgba(200,255,0,.72) !important;
      }
      .liveCap.active { color: var(--pump-gold-hi) !important; }

      .programShelfSlot {
        border-color: rgba(200,255,0,.24) !important;
        background: linear-gradient(180deg, rgba(200,255,0,.07), rgba(255,255,255,.012)) !important;
      }
      .programShelfPulse { color: var(--pump-gold-hi) !important; }

      /* The persistent board is a true ranking. Own ideas remain editable but are
         no longer artificially pinned above higher-scoring proposals. */
      .persistentProposalList {
        display: grid !important;
        gap: 8px !important;
      }
      .persistentProposal {
        display: grid !important;
        grid-template-columns: 24px minmax(0, 1fr) auto auto !important;
        align-items: center !important;
        gap: 9px !important;
        min-width: 0 !important;
        padding: 10px 11px !important;
        border: 1px solid rgba(200,201,203,.10) !important;
        border-radius: 13px !important;
        background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.014)) !important;
      }
      .persistentProposal:not(.own) {
        grid-template-columns: 24px minmax(0, 1fr) auto !important;
      }
      .persistentProposal:first-child {
        border-color: rgba(200,255,0,.26) !important;
        background: linear-gradient(180deg, rgba(200,255,0,.055), rgba(255,255,255,.015)) !important;
      }
      .persistentProposal.own {
        border-color: rgba(200,201,203,.24) !important;
        background: linear-gradient(180deg, rgba(200,201,203,.055), rgba(255,255,255,.014)) !important;
      }
      .proposalRank {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
        font-style: normal !important;
        color: var(--pump-silver-dim) !important;
        text-align: center;
      }
      .persistentProposal:first-child .proposalRank { color: var(--pump-gold-hi) !important; }
      .persistentProposalText { min-width: 0 !important; display: grid !important; gap: 4px !important; }
      .persistentProposalText > span {
        font-size: 13px !important;
        line-height: 1.35 !important;
        white-space: normal !important;
      }
      .persistentProposalText > i {
        min-width: 0;
        display: flex !important;
        align-items: center !important;
        flex-wrap: wrap !important;
        gap: 7px !important;
        font: 600 9px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
        font-style: normal !important;
        color: rgba(200,201,203,.46) !important;
      }
      .persistentProposalText > i > code {
        color: rgba(217,255,51,.72) !important;
        font: inherit !important;
      }
      .persistentProposalText > i > small {
        font: inherit !important;
        color: rgba(200,201,203,.52) !important;
      }
      .proposalTotal {
        min-width: 34px;
        text-align: right;
        color: var(--pump-gold-hi) !important;
        font: 750 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
      }
      .proposalVote,
      .ownIdeaActions > button,
      .persistentIdeaForm > button,
      .boardToggle,
      .walletMetric {
        border-color: rgba(200,201,203,.16) !important;
        color: var(--pump-silver) !important;
        background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015)) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.05) !important;
      }
      .proposalVote:hover,
      .persistentIdeaForm > button:hover,
      .boardToggle:hover,
      .walletMetric:hover {
        border-color: rgba(200,255,0,.38) !important;
        color: var(--pump-gold-hi) !important;
      }
      .proposalVote > b { color: var(--pump-gold-hi) !important; }

      .participationBoard,
      .participationSheet,
      .participationDock {
        --tray-accent: var(--pump-gold);
      }
      .participationDock,
      .participationSheet {
        border-color: rgba(200,201,203,.12) !important;
        background-color: rgba(13,14,15,.95) !important;
      }
      .drawerGrab > i { background: linear-gradient(90deg, var(--pump-silver-dim), var(--pump-gold), var(--pump-silver-dim)) !important; }
      .dockIdeaSummary > b,
      .walletMetric.connected { color: var(--pump-gold-hi) !important; }

      /* v21 — quieter hardware: icon/state/depth, no decorative needles. */
      .minimalTop .wordmark {
        width: 66px !important;
        height: 66px !important;
        opacity: .94;
      }
      .pumptvLogo {
        mix-blend-mode: lighten;
        filter: drop-shadow(0 4px 10px rgba(0,0,0,.28)) saturate(.92) !important;
      }

      .knobStack { gap: 8px !important; }
      .knobControl {
        width: 46px !important;
        height: 34px !important;
        min-width: 46px !important;
        min-height: 34px !important;
        border-radius: 9px !important;
        border-color: rgba(200,201,203,.20) !important;
        color: rgba(200,201,203,.58) !important;
        background:
          linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.012) 54%, rgba(0,0,0,.08)),
          #151617 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.08),
          inset 0 -1px 0 rgba(0,0,0,.72),
          0 3px 0 rgba(0,0,0,.46),
          0 6px 12px rgba(0,0,0,.18) !important;
      }
      .knobControl::after {
        content: "";
        position: absolute;
        right: 5px;
        top: 5px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(125,128,133,.34);
        box-shadow: inset 0 1px rgba(255,255,255,.12);
      }
      .knobControl.on::after {
        background: var(--pump-gold-hi);
        box-shadow: 0 0 5px rgba(217,255,51,.26);
      }
      .knobControl[data-control="fullscreen"]::after { display: none; }
      .knobControl:hover {
        color: var(--pump-silver) !important;
        border-color: rgba(200,201,203,.34) !important;
        transform: translateY(-1px) !important;
      }
      .knobControl:active {
        transform: translateY(2px) !important;
        box-shadow:
          inset 0 2px 5px rgba(0,0,0,.54),
          inset 0 1px rgba(255,255,255,.035),
          0 1px 0 rgba(0,0,0,.42) !important;
      }
      .knobControl.on {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.34) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.09), rgba(255,255,255,.012) 58%, rgba(0,0,0,.09)),
          #171714 !important;
      }
      .knobNeedle { display: none !important; }
      .knobIcon, .knobIcon svg {
        width: 18px !important;
        height: 18px !important;
      }

      /* Episode state reads as physical indexing, not border decoration. */
      .episodeCard {
        opacity: .68 !important;
        transform: none !important;
        background: rgba(255,255,255,.012) !important;
      }
      .episodeCard:hover {
        opacity: .88 !important;
        transform: translateX(-1px) !important;
      }
      .episodeCard.active {
        opacity: 1 !important;
        transform: translateX(-4px) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.07), rgba(255,255,255,.022)) !important;
        box-shadow: 0 5px 14px rgba(0,0,0,.18) !important;
      }
      .episodeCard.active::after {
        content: "" !important;
        position: absolute !important;
        left: -2px !important;
        top: 50% !important;
        width: 3px !important;
        height: 24px !important;
        border-radius: 1px 3px 3px 1px !important;
        transform: translateY(-50%) !important;
        background: linear-gradient(180deg, var(--pump-gold-hi), var(--pump-gold-low)) !important;
        box-shadow: 0 0 7px rgba(200,255,0,.20) !important;
      }
      .episodeCard.active > b::before { content: none !important; }
      .episodeCard.active > b { color: var(--pump-gold-hi) !important; }
      .episodeCard.active .episodeThumb {
        border-color: rgba(200,201,203,.20) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.055), 0 6px 15px rgba(0,0,0,.24) !important;
      }
      .episodeCard.live .episodeThumb > em {
        color: #ff596b !important;
        text-shadow: 0 0 7px rgba(255,89,107,.38) !important;
      }

      /* Proposals read as ranked rows rather than a pile of pills. */
      .persistentProposalList { gap: 6px !important; }
      .persistentProposal {
        min-height: 52px !important;
        padding: 8px 9px !important;
        border-radius: 9px !important;
        border-color: rgba(200,201,203,.075) !important;
        background: rgba(255,255,255,.018) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.022) !important;
      }
      .persistentProposal:hover {
        border-color: rgba(200,201,203,.14) !important;
        background: rgba(255,255,255,.03) !important;
      }
      .persistentProposal:first-child {
        border-color: rgba(200,255,0,.18) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.045), rgba(255,255,255,.016)) !important;
      }
      .persistentProposal.own {
        border-color: rgba(200,201,203,.16) !important;
        background: rgba(200,201,203,.026) !important;
      }
      .proposalRank {
        font-size: 9px !important;
        opacity: .82;
      }
      .persistentProposalText { gap: 3px !important; }
      .persistentProposalText > span {
        font-size: 12px !important;
        line-height: 1.28 !important;
      }
      .persistentProposalText > i {
        gap: 6px !important;
        font-size: 8px !important;
      }
      .proposalTotal { min-width: 26px !important; font-size: 11px !important; }
      .proposalVote {
        min-width: 44px !important;
        height: 29px !important;
        padding: 0 7px !important;
        border-radius: 7px !important;
        gap: 4px !important;
      }
      .ownIdeaActions { gap: 3px !important; }
      .ownIdeaActions > button {
        width: 28px !important;
        height: 28px !important;
        border-radius: 7px !important;
      }
      .persistentIdeaForm > input {
        border-radius: 9px 0 0 9px !important;
      }
      .persistentIdeaForm > button {
        border-radius: 0 9px 9px 0 !important;
      }
      .walletMetric, .boardToggle { border-radius: 8px !important; }

      /* v23: denser drawer + less dashboard-like hierarchy. */
      .participationSheet {
        height: clamp(300px, 40vh, 455px) !important;
        border-radius: 16px !important;
      }
      .drawerGrab { height: 24px !important; }
      .drawerGrab > i {
        width: 42px !important;
        height: 3px !important;
        opacity: .66 !important;
      }
      .participationColumns {
        grid-template-columns: minmax(270px, .72fr) minmax(0, 1.28fr) !important;
      }
      .persistentWorld,
      .persistentIdeas {
        padding: 11px 12px 12px !important;
      }
      .persistentWorld {
        gap: 7px !important;
      }
      .worldLocationCard {
        gap: 4px !important;
        padding: 9px 10px !important;
        border-radius: 9px !important;
      }
      .worldLocationCard > b {
        font-size: 12px !important;
      }
      .worldLocationCard > span {
        display: -webkit-box !important;
        overflow: hidden !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 2 !important;
        font-size: 10px !important;
        line-height: 1.32 !important;
      }
      .persistentWorldItems {
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)) !important;
        gap: 5px !important;
      }
      .persistentWorldItems > button {
        min-height: 49px !important;
        padding: 7px 8px !important;
        border-radius: 8px !important;
      }
      .persistentWorldItems > button > b { font-size: 10px !important; }
      .persistentWorldItems > button > span { font-size: 9px !important; }
      .persistentThreads {
        display: grid !important;
        gap: 3px !important;
      }
      .persistentThreads > span {
        max-width: none !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        padding: 3px 2px !important;
        border: 0 !important;
        border-radius: 0 !important;
        font-size: 8px !important;
        line-height: 1.2 !important;
        opacity: .42 !important;
      }
      .persistentThreads > span::before {
        content: "·";
        margin-right: 5px;
        color: var(--pump-gold-low);
      }
      .persistentIdeas {
        gap: 6px !important;
      }
      .persistentIdeaForm {
        grid-template-columns: minmax(0,1fr) 34px !important;
        gap: 5px !important;
        padding-bottom: 6px !important;
      }
      .persistentIdeaForm > input,
      .persistentIdeaForm > button {
        height: 34px !important;
      }
      .persistentIdeaForm > button { width: 34px !important; }
      .persistentProposal {
        min-height: 47px !important;
        padding: 7px 8px !important;
      }
      .persistentProposalText > span {
        font-size: 11px !important;
      }
      .persistentProposalText > i {
        font-size: 7.5px !important;
      }
      .participationDock {
        min-height: 42px !important;
        padding: 4px 7px !important;
        gap: 6px !important;
        border-radius: 12px !important;
      }
      .boardToggle {
        width: 31px !important;
        height: 31px !important;
      }
      .dockIdeaSummary,
      .viewerMetric,
      .walletMetric { height: 30px !important; }
      .dockIdeaSummary { padding: 0 9px !important; }

      /* Selected episode: underline the media itself instead of a rail-side tab. */
      .episodeCard.active {
        transform: translateX(-2px) !important;
      }
      .episodeCard.active::after {
        content: none !important;
      }
      .episodeCard .episodeThumb {
        position: relative !important;
        overflow: visible !important;
      }
      .episodeCard.active .episodeThumb::after {
        content: "" !important;
        position: absolute !important;
        left: 50% !important;
        bottom: -5px !important;
        width: 28px !important;
        height: 3px !important;
        transform: translateX(-50%) !important;
        border: 0 !important;
        border-radius: 2px !important;
        background: linear-gradient(90deg, var(--pump-gold-low), var(--pump-gold-hi), var(--pump-gold-low)) !important;
        box-shadow: 0 1px 5px rgba(200,255,0,.24) !important;
      }
      .episodeCard.active > b {
        color: var(--pump-gold-hi) !important;
      }

      /* v24: open drawer is a control console, not a second dashboard. */
      .participationSheet {
        height: auto !important;
        max-height: min(46vh, 430px) !important;
      }
      .participationColumns {
        height: auto !important;
        max-height: calc(min(46vh, 430px) - 24px) !important;
      }
      .persistentWorld,
      .persistentIdeas {
        max-height: calc(min(46vh, 430px) - 24px) !important;
      }
      .participationBoard.open .participationDock {
        display: flex !important;
        align-items: center !important;
        min-height: 38px !important;
        padding: 3px 6px !important;
      }
      .participationBoard.open .dockIdeaSummary,
      .participationBoard.open .proposalMetric {
        display: none !important;
      }
      .participationBoard.open .walletMetric {
        margin-left: auto !important;
      }
      .participationBoard.open .participationError {
        flex: 0 0 auto !important;
      }
      .participationBoard.open .boardToggle,
      .participationBoard.open .viewerMetric,
      .participationBoard.open .walletMetric {
        height: 28px !important;
      }
      .participationBoard.open .boardToggle {
        width: 29px !important;
      }
      .participationBoard.open .viewerMetric {
        padding-inline: 7px !important;
      }

      /* Let the proposal list carry the visual hierarchy; chrome stays quiet. */
      .persistentIdeas {
        background: linear-gradient(180deg, rgba(255,255,255,.009), transparent 34%) !important;
      }
      .persistentIdeaForm {
        padding: 0 0 7px !important;
      }
      .persistentProposalList {
        gap: 4px !important;
      }
      .persistentProposal {
        min-height: 44px !important;
        padding: 6px 7px !important;
        border-radius: 7px !important;
      }
      .persistentProposalText > span {
        font-size: 11px !important;
        line-height: 1.22 !important;
      }
      .persistentProposalText > i {
        opacity: .46 !important;
        letter-spacing: .01em !important;
      }
      .proposalVote {
        min-width: 40px !important;
        height: 27px !important;
        padding-inline: 6px !important;
        border-radius: 6px !important;
      }
      .proposalVote svg {
        width: 11px !important;
        height: 11px !important;
      }
      .ownIdeaActions > button {
        width: 26px !important;
        height: 26px !important;
        border-radius: 6px !important;
      }

      /* World state is reference material: compact until intentionally opened. */
      .persistentWorld {
        background: rgba(0,0,0,.055) !important;
      }
      .worldLocationCard {
        min-height: 0 !important;
      }
      .persistentWorldItems > button {
        min-height: 44px !important;
      }
      .persistentThreads {
        margin-top: 1px !important;
      }
      .persistentThreads > span:nth-child(n+5) {
        display: none !important;
      }

      /* Rail state: selected is brighter and indexed, live is independent. */
      .episodeCard.active {
        opacity: 1 !important;
        filter: brightness(1.05) !important;
      }
      .episodeCard:not(.active) .episodeThumb {
        filter: saturate(.86) brightness(.9) !important;
      }
      .episodeCard.active .episodeThumb::after {
        bottom: -4px !important;
        width: 24px !important;
        height: 2px !important;
        box-shadow: 0 1px 4px rgba(200,255,0,.18) !important;
      }

      /* v25: scene index + ranked control surface. */
      .participationSheet {
        background:
          linear-gradient(180deg, rgba(255,255,255,.018), transparent 18%),
          #111316 !important;
        border-color: rgba(200,201,203,.11) !important;
        box-shadow: 0 -16px 48px rgba(0,0,0,.34), inset 0 1px rgba(255,255,255,.035) !important;
      }
      .participationColumns {
        grid-template-columns: minmax(230px, .58fr) minmax(0, 1.42fr) !important;
      }
      .persistentWorld {
        padding: 9px 10px 10px !important;
        gap: 5px !important;
        border-right-color: rgba(255,255,255,.055) !important;
        background: rgba(0,0,0,.09) !important;
      }
      .worldLocationCard {
        padding: 8px 9px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.055) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .worldLocationCard:hover {
        background: rgba(255,255,255,.025) !important;
      }
      .worldLocationCard > b {
        color: rgba(245,245,242,.93) !important;
        font-size: 11px !important;
      }
      .worldLocationCard > span {
        -webkit-line-clamp: 1 !important;
        opacity: .58 !important;
        font-size: 9px !important;
      }
      .persistentWorldItems {
        grid-template-columns: 1fr !important;
        gap: 0 !important;
      }
      .persistentWorldItems > button {
        min-height: 34px !important;
        display: grid !important;
        grid-template-columns: minmax(88px,.72fr) minmax(0,1.28fr) !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 5px 8px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.04) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        text-align: left !important;
      }
      .persistentWorldItems > button:hover {
        background: rgba(255,255,255,.025) !important;
      }
      .persistentWorldItems > button > b {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        color: rgba(239,239,236,.88) !important;
      }
      .persistentWorldItems > button > span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        opacity: .48 !important;
        text-align: right !important;
      }
      .persistentWorldItems.props > button {
        opacity: .72 !important;
      }
      .persistentThreads {
        display: flex !important;
        align-items: center !important;
        gap: 5px !important;
        min-height: 23px !important;
        padding: 3px 6px 0 !important;
        overflow: hidden !important;
      }
      .persistentThreads > span {
        flex: 1 1 0 !important;
        min-width: 0 !important;
        padding: 0 !important;
        font-size: 8px !important;
        opacity: .38 !important;
      }
      .persistentThreads > span::before { content: none !important; }
      .persistentThreads > button {
        flex: 0 0 auto !important;
        height: 20px !important;
        min-width: 26px !important;
        padding: 0 6px !important;
        border: 1px solid rgba(200,255,0,.18) !important;
        border-radius: 5px !important;
        background: rgba(200,255,0,.045) !important;
        color: var(--pump-gold) !important;
        font: 700 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }

      .persistentIdeas {
        padding: 9px 10px 10px !important;
      }
      .persistentIdeaForm {
        gap: 0 !important;
        padding-bottom: 7px !important;
      }
      .persistentIdeaForm > input {
        height: 32px !important;
        border-radius: 7px 0 0 7px !important;
        border-right: 0 !important;
        background: rgba(0,0,0,.16) !important;
      }
      .persistentIdeaForm > button {
        width: 34px !important;
        height: 32px !important;
        border-radius: 0 7px 7px 0 !important;
        background: rgba(255,255,255,.025) !important;
      }
      .persistentProposalList { gap: 2px !important; }
      .persistentProposal {
        position: relative !important;
        grid-template-columns: 24px minmax(0,1fr) auto !important;
        min-height: 42px !important;
        padding: 5px 6px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.055) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .persistentProposal:hover {
        background: rgba(255,255,255,.018) !important;
      }
      .persistentProposal.leader::before {
        content: "" !important;
        position: absolute !important;
        left: 0 !important;
        top: 9px !important;
        bottom: 9px !important;
        width: 2px !important;
        border-radius: 2px !important;
        background: linear-gradient(180deg,var(--pump-gold-hi),var(--pump-gold-low)) !important;
        opacity: .9 !important;
      }
      .persistentProposal.own::after {
        content: "" !important;
        position: absolute !important;
        right: 5px !important;
        top: 5px !important;
        width: 4px !important;
        height: 4px !important;
        border-radius: 50% !important;
        background: var(--pump-silver) !important;
        opacity: .55 !important;
      }
      .proposalRank {
        width: 20px !important;
        text-align: center !important;
        font-size: 8px !important;
        opacity: .42 !important;
      }
      .persistentProposal.leader .proposalRank {
        color: var(--pump-gold-hi) !important;
        opacity: .9 !important;
      }
      .persistentProposalText { gap: 2px !important; }
      .persistentProposalText > span {
        font-size: 10.5px !important;
        line-height: 1.18 !important;
      }
      .persistentProposalText > i {
        display: flex !important;
        align-items: center !important;
        gap: 5px !important;
        font-size: 7px !important;
        opacity: .42 !important;
      }
      .persistentProposalText > i > code {
        color: var(--pump-gold-low) !important;
      }
      .proposalVote {
        min-width: 36px !important;
        height: 25px !important;
        gap: 3px !important;
        border-color: rgba(255,255,255,.075) !important;
        background: rgba(255,255,255,.02) !important;
      }
      .proposalVote:hover {
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(200,255,0,.045) !important;
      }
      .proposalTotal {
        min-width: 20px !important;
        text-align: right !important;
        color: var(--pump-gold-hi) !important;
        font-size: 10px !important;
      }
      .ownIdeaActions { gap: 3px !important; }
      .ownIdeaActions > button {
        width: 24px !important;
        height: 24px !important;
        border-radius: 5px !important;
        background: rgba(255,255,255,.018) !important;
      }

      /* The drawer grab is a hardware seam, not a draggable-app affordance. */
      .drawerGrab { height: 18px !important; }
      .drawerGrab > i {
        width: 34px !important;
        height: 2px !important;
        opacity: .38 !important;
        box-shadow: none !important;
      }


      /* v26: rail + actions read as instrumentation, not thumbnail/button placeholders. */
      .episodeList > .programShelfSlot {
        position: relative !important;
        flex-basis: 54px !important;
        grid-template-columns: 24px minmax(0, 1fr) 22px !important;
        gap: 6px !important;
        padding: 6px 7px !important;
        border-color: rgba(200,255,0,.12) !important;
        border-radius: 9px !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.025), transparent 58%),
          rgba(255,255,255,.012) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.025) !important;
        overflow: hidden !important;
      }
      .programShelfState {
        width: 22px !important;
        height: 36px !important;
        display: grid !important;
        place-items: center !important;
        border-right: 1px solid rgba(255,255,255,.05) !important;
        color: rgba(190,191,188,.48) !important;
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .programShelfSlot.phase-locked .programShelfState,
      .programShelfSlot.phase-planning .programShelfState,
      .programShelfSlot.phase-rendering .programShelfState,
      .programShelfSlot.phase-finalizing .programShelfState {
        color: var(--pump-gold-hi) !important;
        text-shadow: 0 0 7px rgba(200,255,0,.22) !important;
      }
      .programShelfSlot.phase-planning::after,
      .programShelfSlot.phase-rendering::after,
      .programShelfSlot.phase-finalizing::after {
        content: "" !important;
        position: absolute !important;
        left: 7px !important;
        right: 7px !important;
        bottom: 0 !important;
        height: 1px !important;
        background: linear-gradient(90deg, transparent, var(--pump-gold-hi), transparent) !important;
        opacity: .7 !important;
        animation: programRailSweep 1.35s ease-in-out infinite alternate !important;
      }
      @keyframes programRailSweep {
        from { transform: translateX(-42%); opacity: .28; }
        to { transform: translateX(42%); opacity: .85; }
      }
      .programShelfCopy {
        min-width: 0 !important;
        display: flex !important;
        align-items: center !important;
        overflow: hidden !important;
      }
      .programShelfCopy > span {
        display: -webkit-box !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 2 !important;
        overflow: hidden !important;
        color: rgba(236,236,232,.72) !important;
        font-size: 8.5px !important;
        line-height: 1.16 !important;
      }
      .programShelfCopy > i {
        width: 32px !important;
        height: 1px !important;
        background: rgba(255,255,255,.08) !important;
      }
      .programShelfSlot > b {
        align-self: center !important;
        color: rgba(222,222,216,.58) !important;
        font-size: 9px !important;
        opacity: 1 !important;
      }
      .programShelfVisual,
      .programShelfPulse { display: none !important; }

      /* Proposal actions are readouts first, buttons second. */
      .proposalVote {
        min-width: 34px !important;
        height: 28px !important;
        padding: 0 3px !important;
        border: 0 !important;
        border-radius: 4px !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .proposalVote:hover {
        background: rgba(200,255,0,.055) !important;
      }
      .proposalVote > b {
        min-width: 14px !important;
        text-align: right !important;
        font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .proposalVote svg {
        width: 10px !important;
        height: 10px !important;
        opacity: .7 !important;
      }
      .ownIdeaActions > button {
        width: 22px !important;
        height: 22px !important;
        border-color: transparent !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .ownIdeaActions > button:hover {
        border-color: rgba(255,255,255,.07) !important;
        background: rgba(255,255,255,.025) !important;
      }
      .proposalTotal {
        font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .persistentProposalText > i > small {
        font: 650 7px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: .015em !important;
        opacity: .74 !important;
      }

      /* Closed dock: leader is the signal; supporting counters stay visually subordinate. */
      .participationBoard:not(.open) .dockIdeaSummary > span {
        color: rgba(237,237,232,.76) !important;
      }
      .participationBoard:not(.open) .dockIdeaSummary > b {
        font: 750 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .participationBoard:not(.open) .proposalMetric,
      .participationBoard:not(.open) .viewerMetric {
        opacity: .72 !important;
      }

      /* v27: onboarding + score clarity. */
      .participationBoard:not(.open) .participationDock {
        grid-template-columns: auto auto minmax(0, 1fr) auto auto auto !important;
      }
      .participationBoard:not(.open) .boardToggle {
        width: auto !important;
        min-width: 78px !important;
        padding: 0 9px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        border: 1px solid rgba(200,255,0,.18) !important;
        background: rgba(200,255,0,.045) !important;
        color: rgba(241,211,132,.9) !important;
      }
      .boardToggle > span {
        font: 760 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: .07em !important;
        white-space: nowrap !important;
      }
      .boardToggle > svg {
        width: 12px !important;
        height: 12px !important;
      }
      .participationBoard.open .boardToggle > span { display: none !important; }
      .participationBoard.open .boardToggle > svg { transform: rotate(180deg) !important; }
      .persistentProposalText > i > small { display: none !important; }
      .persistentProposalText > i > code {
        font-size: 7.5px !important;
        opacity: .86 !important;
      }
      .proposalTotal {
        min-width: 36px !important;
        padding-inline: 5px !important;
        text-align: right !important;
        white-space: nowrap !important;
        cursor: help !important;
      }
      .proposalVote {
        min-width: 42px !important;
        flex: 0 0 auto !important;
      }
      .proposalVote > b {
        min-width: 22px !important;
        white-space: nowrap !important;
      }
      .walletMetric > b {
        max-width: 48px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }


      /* v33: interaction clarity. */
      .participationBoard svg .stroke {
        fill: none !important;
        stroke: currentColor !important;
        stroke-width: 1.8 !important;
        stroke-linecap: round !important;
        stroke-linejoin: round !important;
      }

      .persistentThreads {
        display: grid !important;
        align-content: start !important;
        gap: 0 !important;
        max-height: 150px !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        padding-right: 3px !important;
        border-top: 1px solid rgba(255,255,255,.045) !important;
        scrollbar-width: thin !important;
      }
      .persistentThreadRow {
        display: grid !important;
        grid-template-columns: 18px minmax(0,1fr) !important;
        gap: 7px !important;
        align-items: start !important;
        padding: 7px 4px !important;
        border-bottom: 1px solid rgba(255,255,255,.045) !important;
        min-width: 0 !important;
      }
      .persistentThreadRow > em {
        margin-top: 1px !important;
        color: var(--pump-gold-low) !important;
        font: 700 7px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        font-style: normal !important;
        text-align: center !important;
        opacity: .75 !important;
      }
      .persistentThreadRow > span {
        min-width: 0 !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        color: rgba(237,237,232,.64) !important;
        font-size: 9px !important;
        line-height: 1.38 !important;
      }

      .persistentIdeaForm.editing {
        grid-template-columns: minmax(0,1fr) 34px 34px !important;
      }
      .persistentIdeaForm.editing > button {
        border-radius: 0 !important;
      }
      .persistentIdeaForm.editing > button:last-child {
        border-radius: 0 7px 7px 0 !important;
      }
      .persistentIdeaForm > button:not(:disabled) {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(200,255,0,.045) !important;
      }
      .persistentIdeaForm > button:disabled {
        opacity: .22 !important;
      }
      .withdrawIdea {
        color: rgba(200,201,203,.52) !important;
        border-left-color: rgba(255,255,255,.06) !important;
      }
      .withdrawIdea:hover {
        color: rgba(255,255,255,.84) !important;
        background: rgba(255,255,255,.04) !important;
      }

      .persistentProposal.own {
        grid-template-columns: 24px minmax(0,1fr) auto !important;
      }
      .ownIdeaActions { display: none !important; }
      .proposalVote svg {
        display: block !important;
        flex: 0 0 auto !important;
        opacity: .9 !important;
      }
      .proposalVote:hover svg { color: var(--pump-gold-hi) !important; }

      .persistentIdeasHead {
        min-height: 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 2px 6px;
        color: rgba(226,226,220,.42);
        font: 750 8px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .1em;
      }
      .persistentIdeasHead > b { color: rgba(226,226,220,.58); font: inherit; }
      .persistentIdeasHead > span { white-space: nowrap; }
      .persistentIdeasHead strong { color: var(--pump-gold-hi); font: inherit; font-variant-numeric: tabular-nums; }

      /* v43: the final frame is an intentional participation state. */
      .mediaDeck .tvVideoLayer,
      .mediaDeck .tvPosterFallback {
        transition: filter 360ms ease, opacity 260ms ease !important;
      }
      .mediaDeck.intermission .tvVideoLayer.active,
      .mediaDeck.intermission .tvPosterFallback {
        filter: brightness(.42) saturate(.72) contrast(.94) !important;
      }
      .yourTurnOverlay {
        position: absolute;
        inset: 0;
        z-index: 18;
        display: grid;
        place-items: center;
        padding: clamp(14px, 3vw, 30px);
        pointer-events: none;
      }
      .yourTurnCard {
        width: min(270px, 72%);
        display: grid;
        justify-items: center;
        gap: 8px;
        padding: 16px 18px 15px;
        border: 1px solid rgba(200,255,0,.19);
        border-radius: 14px;
        background: rgba(8,9,10,.68);
        box-shadow: inset 0 1px rgba(255,255,255,.04), 0 16px 42px rgba(0,0,0,.3);
        backdrop-filter: blur(10px) saturate(.9);
        text-align: center;
        pointer-events: auto;
      }
      .yourTurnKicker {
        color: var(--pump-gold-hi);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .2em;
      }
      .yourTurnCountdown {
        color: rgba(248,248,243,.98);
        font: 800 clamp(28px, 4vw, 40px)/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: -.05em;
      }
      .yourTurnMeta {
        min-height: 11px;
        color: rgba(226,226,220,.52);
        font: 750 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .1em;
      }
      .yourTurnCard > button {
        min-height: 36px;
        margin-top: 1px;
        padding: 0 15px;
        border: 1px solid rgba(200,255,0,.3);
        border-radius: 9px;
        background: rgba(200,255,0,.1);
        color: var(--pump-gold-hi);
        box-shadow: inset 0 1px rgba(255,255,255,.05);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .08em;
        cursor: pointer;
      }
      .yourTurnCard > button:active { transform: translateY(1px); }
      .generationPulse {
        position: absolute;
        left: 50%;
        bottom: clamp(18px, 4vw, 34px);
        z-index: 18;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 10px;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 999px;
        background: rgba(8,9,10,.5);
        color: rgba(242,242,236,.7);
        backdrop-filter: blur(8px);
        pointer-events: none;
        font: 750 8px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .14em;
      }
      .generationPulse > i {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--pump-gold-hi);
        box-shadow: 0 0 10px rgba(200,255,0,.55);
        animation: generationPulse 1.15s ease-in-out infinite alternate;
      }
      @keyframes generationPulse {
        from { opacity: .35; transform: scale(.82); }
        to { opacity: 1; transform: scale(1.08); }
      }

      /* v47: one readable participation surface, no nested mini-scrolls. */
      .participationShade {
        position: fixed;
        inset: 0;
        z-index: 109;
        border: 0;
        padding: 0;
        background: rgba(0,0,0,.26);
        cursor: default;
      }
      .participationBoard.open .participationSheet {
        z-index: 110 !important;
      }
      .persistentProposal {
        align-items: start !important;
      }
      .persistentProposalText {
        min-width: 0 !important;
        cursor: help;
      }
      .persistentProposalText > span {
        display: block !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      .persistentThreads {
        max-height: none !important;
        overflow: visible !important;
        padding-right: 0 !important;
        scrollbar-width: auto !important;
      }
      .persistentThreadRow > span {
        overflow-wrap: anywhere !important;
      }
      .winnerRewardNotice {
        position: fixed;
        left: 50%;
        top: max(18px, env(safe-area-inset-top));
        z-index: 180;
        transform: translateX(-50%);
        min-width: min(330px, calc(100vw - 28px));
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 5px 14px;
        padding: 13px 38px 13px 14px;
        border: 1px solid rgba(200,255,0,.28);
        border-radius: 14px;
        background: rgba(10,11,13,.94);
        box-shadow: 0 18px 48px rgba(0,0,0,.46), inset 0 1px rgba(255,255,255,.05);
        backdrop-filter: blur(18px);
      }
      .winnerRewardNotice > button {
        position: absolute;
        right: 9px;
        top: 8px;
        width: 24px;
        height: 24px;
        border: 0;
        background: transparent;
        color: rgba(255,255,255,.52);
        font-size: 18px;
        cursor: pointer;
      }
      .winnerRewardNotice > b {
        grid-column: 1 / -1;
        color: var(--pump-gold-hi);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .16em;
      }
      .winnerRewardNotice > strong {
        color: rgba(249,249,244,.98);
        font: 820 18px/1.05 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .winnerRewardNotice > span {
        align-self: end;
        color: rgba(235,235,230,.52);
        font: 720 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .1em;
      }
      .winnerRewardNotice.sent { border-color: rgba(140,215,158,.28); }
      .winnerRewardNotice.uncertain { border-color: rgba(225,165,96,.34); }

      @media (max-width: 820px) {
        html, body, #pumptv-page {
          min-height: 100dvh !important;
          max-width: 100vw !important;
          overflow-x: hidden !important;
        }
        .viewerApp {
          width: 100% !important;
          min-height: 100dvh !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: stretch !important;
          overflow-x: hidden !important;
          padding-bottom: max(8px, env(safe-area-inset-bottom)) !important;
        }
        .watchDeck {
          width: 100% !important;
          min-width: 0 !important;
          min-height: 0 !important;
          padding-inline: 6px !important;
          box-sizing: border-box !important;
        }
        .tvCenter {
          width: 100% !important;
          min-width: 0 !important;
          margin-inline: auto !important;
          padding: 0 !important;
        }
        .tvShell {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          aspect-ratio: 1.78 / 1 !important;
          margin: 0 auto !important;
          transform: none !important;
        }
        .minimalTop .wordmark { width: 48px !important; height: 48px !important; }
        .yourTurnOverlay { padding: 10px !important; }
        .yourTurnCard {
          width: min(82vw, 360px) !important;
          padding: 16px 14px 14px !important;
          gap: 7px !important;
          border-radius: 14px !important;
        }
        .yourTurnCountdown { font-size: clamp(28px, 10vw, 38px) !important; }
        .yourTurnCard > button { min-height: 42px !important; width: 100% !important; }
        .episodeShelf {
          position: relative !important;
          inset: auto !important;
          width: 100% !important;
          height: auto !important;
          max-height: none !important;
          min-height: 0 !important;
          flex-direction: row !important;
          align-items: center !important;
          gap: 6px !important;
          padding: 6px !important;
          order: 2 !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
        }
        .episodeShelf > .liveCap {
          flex: 0 0 42px !important;
          width: 42px !important;
          height: 54px !important;
        }
        .episodeShelf > .episodeList {
          flex: 1 1 auto !important;
          width: auto !important;
          height: auto !important;
          min-height: 0 !important;
          display: flex !important;
          flex-direction: row !important;
          gap: 6px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          padding: 0 4px 2px !important;
          scroll-snap-type: x proximity;
        }
        .episodeList > .episodeCard,
        .episodeList > .programShelfSlot {
          flex: 0 0 104px !important;
          width: 104px !important;
          min-width: 104px !important;
          scroll-snap-align: center;
        }
        .participationBoard {
          width: calc(100vw - 12px) !important;
          margin: 7px auto 0 !important;
        }
        .participationSheet {
          position: fixed !important;
          left: 6px !important;
          right: 6px !important;
          bottom: max(6px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          height: min(78dvh, 680px) !important;
          max-height: min(78dvh, 680px) !important;
          min-height: 0 !important;
          z-index: 120 !important;
          border-radius: 18px !important;
        }
        .participationShade {
          z-index: 119 !important;
          background: rgba(0,0,0,.52) !important;
          backdrop-filter: blur(2px);
        }
        .participationBoard.open .participationSheet { z-index: 120 !important; }
        .participationSheet {
          overflow: hidden !important;
        }
        .participationColumns {
          display: block !important;
          height: 100% !important;
          min-height: 0 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          overscroll-behavior: contain !important;
          -webkit-overflow-scrolling: touch;
          padding-bottom: max(16px, env(safe-area-inset-bottom)) !important;
        }
        .persistentWorld,
        .persistentIdeas {
          min-height: auto !important;
          overflow: visible !important;
        }
        .persistentWorld {
          border-bottom: 1px solid rgba(255,255,255,.07) !important;
        }
        .persistentThreads {
          max-height: none !important;
          overflow: visible !important;
        }
        .persistentIdeaForm {
          position: sticky !important;
          top: 0 !important;
          z-index: 4 !important;
        }
        .persistentProposal {
          grid-template-columns: 22px minmax(0,1fr) auto !important;
          gap: 7px !important;
        }
        .persistentProposalText > span {
          font-size: 12px !important;
          line-height: 1.35 !important;
        }
        .winnerRewardNotice {
          top: max(10px, env(safe-area-inset-top)) !important;
          min-width: calc(100vw - 20px) !important;
        }
        .knobControl { width: 42px !important; height: 32px !important; min-width: 42px !important; min-height: 32px !important; }
        .participationBoard {
          width: calc(100vw - 24px);
        }
        .participationDock {
          grid-template-columns: auto auto minmax(0, 1fr) auto auto;
        }
        .participationBoard:not(.open) .boardToggle {
          min-width: 70px !important;
          padding-inline: 7px !important;
        }
        .proposalMetric { display: none; }
        .participationSheet {
          height: min(68vh, 620px) !important;
          max-height: min(68vh, 620px) !important;
          min-height: 360px;
        }
        .participationColumns {
          grid-template-columns: 1fr;
          overflow-y: auto;
        }
        .persistentWorld {
          border-right: 0;
          border-bottom: 1px solid rgba(255,255,255,.07);
          overflow: visible;
        }
        .persistentIdeas {
          overflow: visible;
        }
        .episodeShelf > .episodeList {
          height: auto !important;
        }
      }

      /* v48: authoritative adaptive sheet layout.
         Mobile gets one scroll owner, ideas first, and no sticky controls that
         can float across world/story content. Keep this block last so historic
         density experiments cannot reintroduce nested scrolling. */
      @media (max-width: 900px) {
        .participationSheet {
          position: fixed !important;
          left: 6px !important;
          right: 6px !important;
          bottom: max(6px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          height: min(86dvh, 760px) !important;
          max-height: calc(
            100dvh - max(14px, env(safe-area-inset-top)) -
            max(12px, env(safe-area-inset-bottom))
          ) !important;
          min-height: 0 !important;
          display: grid !important;
          grid-template-rows: auto minmax(0, 1fr) !important;
          overflow: hidden !important;
          overscroll-behavior: none !important;
          border-radius: 18px !important;
          z-index: 220 !important;
        }
        .participationBoard.open .participationSheet {
          z-index: 220 !important;
        }
        .participationShade {
          position: fixed !important;
          inset: 0 !important;
          z-index: 219 !important;
          display: block !important;
          width: 100vw !important;
          height: 100dvh !important;
          pointer-events: auto !important;
          touch-action: none !important;
          background: rgba(0,0,0,.56) !important;
          backdrop-filter: blur(2px);
        }
        .drawerGrab {
          position: relative !important;
          flex: none !important;
          height: 26px !important;
        }
        .participationColumns {
          display: flex !important;
          flex-direction: column !important;
          grid-template-columns: none !important;
          height: 100% !important;
          max-height: none !important;
          min-height: 0 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          overscroll-behavior-y: contain !important;
          -webkit-overflow-scrolling: touch !important;
          touch-action: pan-y !important;
          scrollbar-gutter: stable !important;
          padding: 0 0 max(20px, env(safe-area-inset-bottom)) !important;
        }

        /* Participation is the primary task on a phone. */
        .persistentIdeas {
          order: 1 !important;
          flex: 0 0 auto !important;
          width: 100% !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          padding: 10px 10px 14px !important;
          border-bottom: 1px solid rgba(255,255,255,.07) !important;
        }
        .persistentIdeasHead,
        .persistentIdeaForm {
          position: static !important;
          inset: auto !important;
          top: auto !important;
          z-index: auto !important;
        }
        .persistentIdeaForm {
          margin: 0 0 8px !important;
          padding: 0 !important;
        }
        .persistentProposalList {
          max-height: none !important;
          overflow: visible !important;
        }
        .persistentProposal {
          align-items: start !important;
          grid-template-columns: 22px minmax(0,1fr) auto !important;
          min-height: 0 !important;
          padding-block: 9px !important;
        }
        .persistentProposalText {
          min-width: 0 !important;
        }
        .persistentProposalText > span {
          display: block !important;
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          font-size: 12px !important;
          line-height: 1.38 !important;
        }

        /* World state is secondary reference material and follows ideas. */
        .persistentWorld {
          order: 2 !important;
          flex: 0 0 auto !important;
          width: 100% !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          padding: 10px !important;
          border-right: 0 !important;
          border-bottom: 0 !important;
        }
        .persistentWorldItems {
          overflow: visible !important;
        }
        .persistentWorldItems > button {
          min-height: 0 !important;
          grid-template-columns: minmax(96px,.38fr) minmax(0,.62fr) !important;
          align-items: start !important;
          gap: 10px !important;
          padding-block: 8px !important;
        }
        .persistentWorldItems > button > b,
        .persistentWorldItems > button > span {
          min-width: 0 !important;
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          text-align: left !important;
          line-height: 1.34 !important;
        }
        .persistentThreads {
          display: grid !important;
          max-height: none !important;
          min-height: 0 !important;
          overflow: visible !important;
          overscroll-behavior: auto !important;
          padding-right: 0 !important;
          scrollbar-width: auto !important;
        }
        .persistentThreadRow {
          min-height: 0 !important;
          padding-block: 9px !important;
        }
        .persistentThreadRow > span {
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          font-size: 10px !important;
          line-height: 1.42 !important;
        }
      }

      @media (max-width: 560px) {
        .participationSheet {
          left: 4px !important;
          right: 4px !important;
          bottom: max(4px, env(safe-area-inset-bottom)) !important;
          height: min(88dvh, 760px) !important;
          border-radius: 16px !important;
        }
        .persistentWorldItems > button {
          grid-template-columns: 1fr !important;
          gap: 3px !important;
        }
        .persistentWorldItems > button > span {
          opacity: .58 !important;
        }
      }


      /* MEME TV: black / white / acid visual system from the supplied mark. */
      html,
      body,
      #pumptv-page,
      .viewerApp {
        background: #000 !important;
        color: var(--meme-white) !important;
      }

      .minimalTop .wordmark {
        width: 178px !important;
        height: 54px !important;
        overflow: visible !important;
        opacity: 1 !important;
      }
      .pumptvLogo {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        object-position: left center !important;
        mix-blend-mode: normal !important;
        filter: drop-shadow(0 5px 18px rgba(200,255,0,.08)) !important;
      }

      .participationDock,
      .participationSheet,
      .episodeShelf,
      .richHoverTooltip,
      .winnerRewardNotice {
        background-color: rgba(4,5,4,.965) !important;
        border-color: rgba(200,255,0,.12) !important;
      }

      .participationDock {
        background:
          linear-gradient(180deg, rgba(15,18,12,.96), rgba(3,4,3,.96)) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.045),
          0 16px 42px rgba(0,0,0,.38) !important;
      }

      .drawerGrab > i {
        background: linear-gradient(
          90deg,
          transparent,
          var(--meme-acid),
          transparent
        ) !important;
      }

      .yourTurnCard {
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(0,0,0,.78) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.04),
          0 18px 50px rgba(0,0,0,.48),
          0 0 30px rgba(200,255,0,.035) !important;
      }
      .yourTurnKicker,
      .persistentIdeasHead strong,
      .proposalVote > b,
      .episodeCard.active > b,
      .dockIdeaSummary > b,
      .walletMetric.connected {
        color: var(--meme-acid-hi) !important;
      }
      .yourTurnCard > button,
      .persistentIdeaForm > button:not(:disabled) {
        border-color: var(--meme-acid) !important;
        background: var(--meme-acid) !important;
        color: #050604 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.34),
          0 0 18px rgba(200,255,0,.08) !important;
      }
      .yourTurnCard > button:hover,
      .persistentIdeaForm > button:not(:disabled):hover {
        background: var(--meme-acid-hi) !important;
        color: #000 !important;
      }

      .persistentIdeaForm > input:focus,
      .ideaForm > input:focus {
        border-color: rgba(200,255,0,.52) !important;
        box-shadow: 0 0 0 2px rgba(200,255,0,.06) !important;
      }

      .proposalVote:hover,
      .boardToggle:hover,
      .participationBoard.open .boardToggle,
      .walletMetric:hover {
        border-color: rgba(200,255,0,.34) !important;
        color: var(--meme-acid-hi) !important;
      }

      .episodeCard.active {
        background: linear-gradient(
          90deg,
          rgba(200,255,0,.075),
          rgba(255,255,255,.012)
        ) !important;
      }
      .episodeCard.active::after {
        background: linear-gradient(
          180deg,
          var(--meme-acid-hi),
          var(--meme-acid-low)
        ) !important;
        box-shadow: 0 0 10px rgba(200,255,0,.28) !important;
      }

      .statusDot.ready,
      .statusDot.work,
      .powerLamp.ready,
      .powerLamp.work,
      .generationPulse > i {
        background: var(--meme-acid-hi) !important;
        box-shadow:
          0 0 0 1px rgba(200,255,0,.20),
          0 0 12px rgba(200,255,0,.32) !important;
      }

      .knobControl.on {
        border-color: rgba(200,255,0,.32) !important;
        color: var(--meme-acid-hi) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.075), rgba(255,255,255,.01)),
          #0c0e0b !important;
      }
      .knobControl.on::after {
        background: var(--meme-acid-hi) !important;
        box-shadow: 0 0 7px rgba(200,255,0,.30) !important;
      }

      .tvShell {
        border-color: rgba(200,255,0,.10) !important;
        background:
          linear-gradient(145deg, #171b15 0%, #090b08 62%, #050605 100%) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.045),
          inset 0 0 0 1px rgba(0,0,0,.72),
          0 24px 80px rgba(0,0,0,.46) !important;
      }
      .tvScreenFrame {
        border-color: rgba(200,255,0,.07) !important;
        background: #020302 !important;
      }

      .winnerRewardNotice > b,
      .winnerRewardNotice > a {
        color: var(--meme-acid-hi) !important;
      }

      @media (max-width: 820px) {
        .minimalTop .wordmark {
          width: 132px !important;
          height: 40px !important;
        }
      }

      @media (max-width: 560px) {
        .minimalTop .wordmark {
          width: 116px !important;
          height: 36px !important;
        }
      }

      .currentPromptFact {
        margin-left: 12px;
        padding-left: 12px;
        border-left: 1px solid rgba(200,255,0,.30);
        color: var(--meme-acid-hi);
        font-size: .82em;
        font-weight: 800;
        white-space: nowrap;
        letter-spacing: .02em;
      }

      ::selection {
        background: var(--meme-acid);
        color: #000;
      }

      button:focus-visible,
      input:focus-visible,
      a:focus-visible,
      [role="button"]:focus-visible {
        outline: 2px solid var(--meme-acid-hi) !important;
        outline-offset: 2px !important;
      }

      .participationSheet,
      .persistentIdeas,
      .persistentWorld {
        scrollbar-color: rgba(200,255,0,.34) rgba(255,255,255,.035);
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          scroll-behavior: auto !important;
          animation-duration: .001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: .001ms !important;
        }
      }

      /* v56: phone-first composition. The desktop television is decorative; on
         phones the video itself is the product. Flatten the chassis, move the
         controls over the picture, and keep participation/history compact. */
      @media (max-width: 820px) {
        html,
        body,
        #pumptv-page {
          min-height: 100dvh !important;
          background: #000 !important;
        }

        .viewerApp {
          min-height: 0 !important;
          display: block !important;
          padding: max(8px, env(safe-area-inset-top)) 0
            max(12px, env(safe-area-inset-bottom)) !important;
        }

        .watchDeck {
          width: 100% !important;
          padding: 0 10px !important;
        }

        .minimalTop {
          min-height: 50px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 12px !important;
          padding: 2px 4px 8px !important;
        }
        .minimalTop .wordmark {
          width: 124px !important;
          height: 38px !important;
        }
        .tinyStatus {
          position: static !important;
          margin-left: auto !important;
        }

        .tvCenter {
          width: 100% !important;
          margin: 0 !important;
        }

        .tvShell {
          position: relative !important;
          display: block !important;
          width: 100% !important;
          max-width: none !important;
          height: auto !important;
          min-height: 0 !important;
          aspect-ratio: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
          border-radius: 18px !important;
          background: transparent !important;
          box-shadow: none !important;
          overflow: visible !important;
        }
        .tvScrew { display: none !important; }

        .tvScreenFrame {
          position: relative !important;
          inset: auto !important;
          grid-column: auto !important;
          width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          aspect-ratio: 16 / 9 !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 1px solid rgba(200,255,0,.16) !important;
          border-radius: 18px !important;
          background: #030403 !important;
          box-shadow: 0 14px 44px rgba(0,0,0,.36) !important;
          overflow: hidden !important;
        }
        .tvGlass {
          width: 100% !important;
          height: 100% !important;
          border-radius: inherit !important;
          overflow: hidden !important;
        }

        /* Keep the useful controls, lose the side hardware column. */
        .tvHardware {
          position: absolute !important;
          z-index: 32 !important;
          top: 9px !important;
          right: 9px !important;
          width: auto !important;
          height: auto !important;
          min-width: 0 !important;
          min-height: 0 !important;
          display: block !important;
          padding: 0 !important;
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
          pointer-events: none !important;
        }
        .tvHardware .powerLamp,
        .tvHardware .speaker {
          display: none !important;
        }
        .tvHardware .knobStack {
          display: flex !important;
          flex-direction: row !important;
          gap: 5px !important;
          pointer-events: auto !important;
        }
        .tvHardware .knobControl {
          width: 34px !important;
          height: 32px !important;
          min-width: 34px !important;
          min-height: 32px !important;
          border-radius: 9px !important;
          background: rgba(3,4,3,.72) !important;
          backdrop-filter: blur(10px) !important;
        }
        .tvHardware .knobIcon,
        .tvHardware .knobIcon svg {
          width: 16px !important;
          height: 16px !important;
        }

        /* Intermission is a compact action surface at the bottom of the image,
           not a desktop modal floating in the middle. */
        .yourTurnOverlay {
          place-items: end stretch !important;
          padding: 9px !important;
        }
        .yourTurnCard {
          width: 100% !important;
          max-width: none !important;
          box-sizing: border-box !important;
          gap: 7px !important;
          padding: 12px !important;
          border-radius: 13px !important;
          background: rgba(0,0,0,.82) !important;
          backdrop-filter: blur(12px) !important;
        }
        .yourTurnKicker { font-size: 9px !important; }
        .yourTurnCountdown {
          font-size: 28px !important;
          line-height: .95 !important;
        }
        .yourTurnMeta { font-size: 9px !important; }
        .yourTurnCard > button {
          width: 100% !important;
          min-height: 42px !important;
          margin: 0 !important;
          border-radius: 10px !important;
          font-size: 10px !important;
        }

        .participationBoard {
          width: 100% !important;
          margin: 8px 0 0 !important;
        }
        .participationDock {
          min-height: 46px !important;
          grid-template-columns: auto auto 1fr !important;
          gap: 8px !important;
          padding: 6px !important;
          border-radius: 13px !important;
        }
        .dockIdeaSummary,
        .proposalMetric,
        .participationError {
          display: none !important;
        }
        .boardToggle {
          width: auto !important;
          min-width: 104px !important;
          height: 34px !important;
          padding: 0 10px !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 7px !important;
        }
        .viewerMetric {
          min-width: 48px !important;
          justify-self: start !important;
        }
        .walletMetric {
          justify-self: end !important;
          min-width: 40px !important;
        }

        .episodeShelf {
          width: 100% !important;
          height: auto !important;
          max-height: none !important;
          margin: 8px 0 0 !important;
          padding: 0 10px !important;
          display: block !important;
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
          overflow: visible !important;
        }
        .episodeShelf > .liveCap { display: none !important; }
        .episodeShelf > .episodeList {
          width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          display: flex !important;
          flex-direction: row !important;
          gap: 8px !important;
          padding: 0 0 4px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          scroll-snap-type: x proximity !important;
          scrollbar-width: none !important;
        }
        .episodeShelf > .episodeList::-webkit-scrollbar { display: none !important; }
        .episodeList > .episodeCard,
        .episodeList > .programShelfSlot {
          flex: 0 0 118px !important;
          width: 118px !important;
          min-width: 118px !important;
          transform: none !important;
          scroll-snap-align: start !important;
        }
      }

      @media (max-width: 480px) {
        .watchDeck { padding-inline: 8px !important; }
        .minimalTop .wordmark {
          width: 112px !important;
          height: 34px !important;
        }
        .tvScreenFrame { border-radius: 15px !important; }
        .tvHardware { top: 7px !important; right: 7px !important; }
        .tvHardware .knobControl {
          width: 32px !important;
          height: 30px !important;
          min-width: 32px !important;
          min-height: 30px !important;
        }
        .participationDock { gap: 6px !important; }
        .boardToggle { min-width: 96px !important; }
        .viewerMetric { min-width: 42px !important; }
        .episodeShelf { padding-inline: 8px !important; }
      }

    `}</style>
  );
}
