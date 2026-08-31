/** @jsxImportSource jsx-ai */

/**
 * JSX-AI tool surface for the PumpTV showrunner.
 *
 * The model does not return a giant state blob. It stages one shot, then emits
 * only the canon mutations that the shot actually establishes. The server
 * applies those mutations to the durable prior state.
 */
export function StageShotTool() {
  return (
    <tool
      name="stage_shot"
      description="Commit the single five-second shot to generate next. Call exactly once."
    >
      <param name="premise" type="string" required>
        One-sentence dramatic intent for the shot.
      </param>
      <param name="transition" type="string" required>
        How the first 1–2 seconds continue directly from the previous final
        frame before the Pump.fun idea takes over.
      </param>
      <param name="action" type="string" required>
        One concrete, physically readable causal beat that happens during these
        five seconds.
      </param>
      <param name="continuity" type="string" required>
        What identities, wardrobe, props, geography, pose, eyelines, motion,
        lighting, and screen direction must remain continuous.
      </param>
      <param name="camera" type="string" required>
        One coherent camera setup or motivated cut.
      </param>
      <param name="visual_details" type="string" required>
        Only visible production details H3 needs for this shot.
      </param>
      <param name="audio" type="string" required>
        Motivated ambience and synchronized foley for the shot.
      </param>
      <param name="dialogue" type="string">
        Optional short spoken line. Leave empty when dialogue is unnecessary.
      </param>
      <param name="ending_beat" type="string" required>
        Exact active visual state the final frame should land on so another shot
        can continue immediately.
      </param>
    </tool>
  );
}

export function CanonMutationTools() {
  return (
    <>
      <tool
        name="set_location"
        description="Change or establish the durable location only when this shot visibly establishes it. Omit if location is unchanged."
      >
        <param name="location" type="string" required>
          Short stable location name.
        </param>
        <param name="details" type="string" required>
          Durable spatial/environment details that later shots must preserve.
        </param>
      </tool>

      <tool
        name="upsert_character"
        description="Create or update one persistent character only for facts visibly established by this shot. Call once per changed/new character; omit unchanged characters."
      >
        <param name="id" type="string" required>
          Stable machine-friendly id. Reuse an existing id when updating a known
          character.
        </param>
        <param name="name" type="string" required>
          Display name.
        </param>
        <param name="appearance" type="string" required>
          Durable visible physical appearance.
        </param>
        <param name="wardrobe" type="string" required>
          Current visible wardrobe.
        </param>
        <param name="status" type="string" required>
          Current physical/story status after this shot.
        </param>
        <param name="position" type="string" required>
          Where the character is at the final frame.
        </param>
      </tool>

      <tool
        name="upsert_prop"
        description="Create or update one persistent prop only when this shot visibly establishes a change. Call once per changed/new prop; omit unchanged props."
      >
        <param name="id" type="string" required>
          Stable machine-friendly id. Reuse an existing id for a known prop.
        </param>
        <param name="name" type="string" required>
          Short prop name.
        </param>
        <param name="description" type="string" required>
          Durable visible description.
        </param>
        <param name="status" type="string" required>
          Current state after this shot.
        </param>
        <param name="position" type="string" required>
          Where the prop is at the final frame.
        </param>
      </tool>

      <tool
        name="open_thread"
        description="Remember one unresolved plot question created or reinforced by this shot. Do not duplicate an existing thread."
      >
        <param name="thread" type="string" required>
          Short unresolved story thread.
        </param>
      </tool>

      <tool
        name="resolve_thread"
        description="Resolve one existing open thread only when this shot clearly resolves it."
      >
        <param name="thread" type="string" required>
          Existing thread text or a distinctive exact fragment identifying it.
        </param>
      </tool>

      <tool
        name="remember_motif"
        description="Persist a recurring visual/story motif newly established by this shot. Omit ordinary one-off details."
      >
        <param name="motif" type="string" required>
          Short recurring motif.
        </param>
      </tool>

      <tool
        name="remember_visual_rule"
        description="Persist a durable visual invariant that future shots should keep. Omit temporary lighting/action details."
      >
        <param name="rule" type="string" required>
          Short durable visual invariant.
        </param>
      </tool>
    </>
  );
}

export function PumpTVProductionTools() {
  return (
    <>
      <StageShotTool />
      <CanonMutationTools />
    </>
  );
}
