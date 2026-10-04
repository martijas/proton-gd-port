// Turning what the simulation did into what the player hears.
//
// Both event lists — the simulation's and the trigger runtime's — are plain
// append-only arrays that a checkpoint restore *truncates* (`sim.ts` saves and
// restores `eventsLen`, and so does the trigger runtime). So this reads them by
// cursor rather than by subscription, and clamps the cursor whenever an array
// has become shorter than it was. A respawn does not replay what it wound
// back over: the level's sound is rebuilt at the checkpoint's music time
// (LevelAudio.respawn) and the cursors are moved past the checkpoint's own
// events (`skip`), so only what happens after it plays live, the respawn's
// own spawn included.
//
// `SimOptions.onEvent` is deliberately not used for this. It fires inside the
// autoplayer's speculative branches and inside snapshot/restore cycles, and
// there is no way to take a sound back once it has started.

import type { Sim, SimEvent } from "../physics/types";
import { AUDIO_EVENT_KINDS, type TriggerEvent } from "../triggers/runtime";
import { EVENT_SOUNDS } from "./names";

/** What the drain talks to. Kept tiny so it can be a recorder in a test. */
export interface SoundSink {
  /** A one-shot effect at the game's volume for it: a death, a finish. */
  effect(name: string, volume: number): void;
  /**
   * An audio trigger fired; what it sounds like is the sink's to work out.
   * `seq` is its place in the trigger events, which a respawn cuts back to.
   */
  trigger(e: TriggerEvent, sim: Sim, seq: number): void;
}

export class EventDrain {
  private simCursor = 0;
  private triggerCursor = 0;
  /** The effects already heard this tick, so both players dying is one sound. */
  private readonly thisTick = new Set<string>();
  private lastTick = -1;

  /**
   * Plays everything that has happened since the last call.
   *
   * Called once a frame rather than once a tick: at 240 Hz a per-tick call
   * would schedule the same sound four times for one 60 Hz frame of gameplay,
   * and nothing the player hears needs sub-frame placement.
   */
  drain(sim: Sim, sink: SoundSink, practice = false): void {
    const sounds = sim.events;
    const triggers = sim.triggers.events;

    // A restore shortened one or both lists; wind back to the new end.
    if (sounds.length < this.simCursor) this.simCursor = sounds.length;
    if (triggers.length < this.triggerCursor) this.triggerCursor = triggers.length;

    for (; this.simCursor < sounds.length; this.simCursor++) this.playSim(sounds[this.simCursor], sim, sink, practice);
    for (; this.triggerCursor < triggers.length; this.triggerCursor++) {
      this.playTrigger(triggers[this.triggerCursor], this.triggerCursor, sim, sink);
    }
  }

  /**
   * A fresh attempt with nothing warmed up: everything from the start fires,
   * the reset check's tick-0 triggers included, as startMusic plays the ones
   * it queued. [gdp PlayLayer::startMusic → processQueuedAudioTriggers :105404]
   */
  reset(): void {
    this.simCursor = 0;
    this.triggerCursor = 0;
    this.thisTick.clear();
    this.lastTick = -1;
  }

  /**
   * After a rebuild: everything so far is accounted for. A respawn passes how
   * many trigger events its checkpoint kept, and what its key 448 spawn fired
   * after them is still to be heard.
   */
  skip(sim: Sim, triggers = sim.triggers.events.length): void {
    this.simCursor = sim.events.length;
    this.triggerCursor = Math.min(triggers, sim.triggers.events.length);
    this.thisTick.clear();
    this.lastTick = -1;
  }

  private once(tick: number, key: string): boolean {
    if (tick !== this.lastTick) {
      this.thisTick.clear();
      this.lastTick = tick;
    }
    if (this.thisTick.has(key)) return false;
    this.thisTick.add(key);
    return true;
  }

  private playSim(e: SimEvent, sim: Sim, sink: SoundSink, practice: boolean): void {
    const rule = EVENT_SOUNDS[e.type];
    // Every event type has an entry; a null one is a sound the game does not
    // have, not a gap. See names.ts.
    if (!rule?.sfx) return;
    // The end sound belongs to the complete effect, which practice skips, and
    // an End trigger with key 461 asks for silence. Nothing steps after a
    // finish, so the sim's end is still the one that made this event.
    // [gdp PlayLayer::levelComplete :92891-92904; showCompleteEffect :88845-88870]
    if (e.type === "finish" && (practice || (sim.end && !sim.end.sound))) return;
    // Options key 576. [gdp PlayLayer::destroyPlayer :93293-93298]
    if (e.type === "die" && sim.triggers.visual.options.noDeathSfx) return;
    if (!this.once(e.tick, e.type)) return;
    sink.effect(rule.sfx, rule.volume ?? 1);
  }

  /**
   * Every activation is heard, the same trigger twice in a tick included, as
   * when two Spawn triggers spawn its group together: the game has no
   * per-frame check on the way to the sound, and what it does have — a
   * unique sound, the minimum interval — the sink applies.
   * [gdp GJBaseGameLayer::activateSFXTrigger :447147-447225 →
   *  GameManager::playSFXTrigger :108930-109007 → playEffectAdvanced
   *  :73942-74280; activateSongTrigger :446501-446556]
   */
  private playTrigger(e: TriggerEvent, seq: number, sim: Sim, sink: SoundSink): void {
    if (!AUDIO_EVENT_KINDS.has(e.kind)) return;
    sink.trigger(e, sim, seq);
  }
}
