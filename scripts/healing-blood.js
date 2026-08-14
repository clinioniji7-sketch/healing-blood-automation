const HB_EFFECT_NAME = "Healing Blood";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_SOURCE = "healingBloodLastDamageSource";
const HB_FLAG_SCOPE = "world";
const RECENT_SOURCE_MS = 20000;

function hasHealingBlood(actor) {
  return !!actor?.effects?.some(e =>
    !e.disabled &&
    e.name?.toLowerCase() === HB_EFFECT_NAME.toLowerCase()
  );
}

function getHP(actor) {
  return {
    value: Number(foundry.utils.getProperty(actor, "system.attributes.hp.value")) || 0,
    max: Number(foundry.utils.getProperty(actor, "system.attributes.hp.max")) || 0
  };
}

async function healActor(actor, amount) {
  if (!actor) return 0;
  amount = Math.max(0, Number(amount) || 0);
  const hp = getHP(actor);
  const effective = Math.min(amount, Math.max(0, hp.max - hp.value));
  if (effective <= 0) return 0;
  await actor.update({ "system.attributes.hp.value": hp.value + effective });
  return effective;
}

async function accumulateDamage(actor, amount) {
  amount = Math.max(0, Number(amount) || 0);
  if (!actor || amount <= 0) return;
  const current = Number(actor.getFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE)) || 0;
  await actor.setFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE, current + amount);
  console.log(`Healing Blood | ${actor.name}: +${amount} dano (${current + amount} acumulado).`);
}

async function clearDamage(actor) {
  try { await actor?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE); } catch (_) {}
}

function asActor(subject) {
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  if (subject.actor?.documentName === "Actor") return subject.actor;
  if (subject.parent?.documentName === "Actor") return subject.parent;
  if (subject.item?.actor) return subject.item.actor;
  if (subject.parent?.actor) return subject.parent.actor;
  return null;
}

function getTargetActorIds() {
  return [...game.user.targets].map(t => t.actor?.id).filter(Boolean);
}

async function rememberDamageSource(subject) {
  const attacker = asActor(subject) ?? asActor(subject?.item) ?? asActor(subject?.parent) ?? null;
  if (!attacker) {
    console.warn("Healing Blood | Não foi possível descobrir o Actor que rolou o dano.", subject);
    return;
  }

  const data = {
    time: Date.now(),
    attackerId: attacker.id,
    attackerUuid: attacker.uuid,
    targetActorIds: getTargetActorIds(),
    sourceName: subject?.name ?? subject?.item?.name ?? subject?.parent?.name ?? "Dano"
  };

  try {
    await attacker.setFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE, data);
    console.log("Healing Blood | Fonte de dano registrada:", attacker.name, data);
  } catch (error) {
    console.warn("Healing Blood | Falha ao registrar fonte de dano.", error);
  }
}

function findRecentDamageSource(targetActor) {
  const now = Date.now();
  let best = null;

  for (const attacker of game.actors) {
    const data = attacker.getFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE);
    if (!data) continue;

    const age = now - Number(data.time || 0);
    if (age < 0 || age > RECENT_SOURCE_MS) continue;

    const targets = Array.isArray(data.targetActorIds) ? data.targetActorIds : [];
    if (targets.length && !targets.includes(targetActor.id)) continue;

    if (!best || Number(data.time || 0) > Number(best.data.time || 0)) {
      best = { attacker, data };
    }
  }

  return best;
}

async function consumeDamageSource(attacker) {
  try { await attacker?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE); } catch (_) {}
}

async function healDamageSource(attacker, targetActor, damage) {
  if (!attacker || !targetActor || attacker.id === targetActor.id) return;

  damage = Math.max(0, Number(damage) || 0);
  const dice = Math.floor(damage / 7);
  if (dice <= 0) return;

  const roll = await new Roll(`${dice}d4`).evaluate();
  const effectiveHealing = await healActor(attacker, roll.total);

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    flavor:
      `<b>Healing Blood</b><br>` +
      `<b>${attacker.name}</b> fez ${targetActor.name} perder <b>${damage} PV</b>.<br>` +
      `Cura: <b>${dice}d4 = ${roll.total}</b><br>` +
      `Cura efetiva: <b>${effectiveHealing} PV</b>.`
  });
}

Hooks.once("ready", () => {
  if (globalThis.HealingBloodAutomation?.active) return;

  console.log("Healing Blood | Iniciando automação v1.0.4...");

  const rollDamageHook = Hooks.on("dnd5e.rollDamage", async (rolls, data = {}) => {
    await rememberDamageSource(data?.subject);
  });

  const rollDamageV2Hook = Hooks.on("dnd5e.rollDamageV2", async (rolls, data = {}) => {
    await rememberDamageSource(data?.subject);
  });

  const actorDamageHook = Hooks.on("dnd5e.damageActor", async (actor, changes = {}) => {
    if (!game.user.isGM) return;
    if (!actor || !hasHealingBlood(actor)) return;

    let amount = Math.abs(Number(changes?.total) || 0);
    if (amount <= 0) {
      const hpLoss = Math.min(0, Number(changes?.hp) || 0);
      const tempLoss = Math.min(0, Number(changes?.temp) || 0);
      amount = Math.abs(hpLoss + tempLoss);
    }
    if (amount <= 0) return;

    await accumulateDamage(actor, amount);

    const source = findRecentDamageSource(actor);
    if (source?.attacker) {
      await healDamageSource(source.attacker, actor, amount);
      await consumeDamageSource(source.attacker);
    } else {
      console.log(`Healing Blood | ${actor.name} perdeu ${amount} PV, mas nenhuma fonte de dano recente foi localizada.`);
    }
  });

  const combatHook = Hooks.on("updateCombat", async (combat, changed) => {
    if (!game.user.isGM) return;
    const changedTurn = Object.prototype.hasOwnProperty.call(changed, "turn");
    const changedRound = Object.prototype.hasOwnProperty.call(changed, "round");
    if (!changedTurn && !changedRound) return;

    const processed = new Set();
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor || processed.has(actor.id)) continue;
      processed.add(actor.id);
      if (!hasHealingBlood(actor)) continue;

      const damage = Number(actor.getFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE)) || 0;
      if (damage <= 0) continue;

      const dexMod = Number(foundry.utils.getProperty(actor, "system.abilities.dex.mod")) || 0;
      const halfDamage = Math.floor(damage / 2);
      const healing = Math.max(0, halfDamage + dexMod);
      const effectiveHealing = await healActor(actor, healing);
      await clearDamage(actor);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content:
          `<div class="chat-card">` +
          `<h2>Healing Blood</h2>` +
          `<p><b>${actor.name}</b> sofreu <b>${damage} de dano</b> durante o turno.</p>` +
          `<p>Metade: <b>${halfDamage}</b><br>` +
          `Mod. Agilidade: <b>${dexMod >= 0 ? "+" : ""}${dexMod}</b></p>` +
          `<hr><p>Recupera <b>${effectiveHealing} PV</b>.</p>` +
          `</div>`
      });
    }
  });

  const effectUpdateHook = Hooks.on("updateActiveEffect", async (effect, changed) => {
    if (!game.user.isGM) return;
    const actor = effect.parent;
    if (!actor) return;
    if (effect.name?.toLowerCase() !== HB_EFFECT_NAME.toLowerCase()) return;
    if (changed.disabled === true) await clearDamage(actor);
  });

  const effectDeleteHook = Hooks.on("deleteActiveEffect", async effect => {
    if (!game.user.isGM) return;
    const actor = effect.parent;
    if (!actor) return;
    if (effect.name?.toLowerCase() !== HB_EFFECT_NAME.toLowerCase()) return;
    await clearDamage(actor);
  });

  globalThis.HealingBloodAutomation = {
    active: true,
    version: "1.0.4",
    rollDamageHook,
    rollDamageV2Hook,
    actorDamageHook,
    combatHook,
    effectUpdateHook,
    effectDeleteHook
  };

  ui.notifications.info("Healing Blood Automation v1.0.4 carregada.");
  console.log("Healing Blood | Automação v1.0.4 ativa.");
});
