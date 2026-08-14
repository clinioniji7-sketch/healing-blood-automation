const HB_EFFECT_NAME = "Healing Blood";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_SOURCE = "healingBloodLastDamageSource";
const HB_FLAG_SCOPE = "world";
const RECENT_SOURCE_MS = 60000;

function hasHealingBlood(actor) {
  return !!actor?.effects?.some(e =>
    !e.disabled &&
    e.name?.toLowerCase() === HB_EFFECT_NAME.toLowerCase()
  );
}

function getHP(actor) {
  const hp = foundry.utils.getProperty(actor, "system.attributes.hp") ?? {};
  const value = Number(hp.value) || 0;
  const max = Number(hp.max) || 0;
  const tempmax = Number(hp.tempmax) || 0;
  return { value, max, tempmax, effectiveMax: Math.max(0, max + tempmax) };
}

async function healActor(actor, amount) {
  if (!actor) return 0;
  amount = Math.max(0, Number(amount) || 0);
  const hp = getHP(actor);
  const missing = Math.max(0, hp.effectiveMax - hp.value);
  const effective = Math.min(amount, missing);
  console.log("Healing Blood | healActor:", actor.name, { amount, hp });
  if (effective <= 0) return 0;
  await actor.update({ "system.attributes.hp.value": hp.value + effective });
  return effective;
}

async function accumulateDamage(actor, amount) {
  if (!actor) return;
  amount = Math.max(0, Number(amount) || 0);
  if (amount <= 0) return;
  const current = Number(actor.getFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE)) || 0;
  await actor.setFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE, current + amount);
  console.log(`Healing Blood | ${actor.name}: +${amount} dano (${current + amount} acumulado).`);
}

async function clearDamage(actor) {
  try { await actor?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE); } catch (_) {}
}

function getActorFromSpeaker(message) {
  const sceneId = message?.speaker?.scene;
  const tokenId = message?.speaker?.token;
  const actorId = message?.speaker?.actor;

  if (sceneId && tokenId) {
    const scene = game.scenes.get(sceneId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    if (tokenDoc?.actor) return { actor: tokenDoc.actor, sceneId, tokenId, actorId: tokenDoc.actor.id, synthetic: true };
  }

  if (tokenId) {
    const token = canvas.tokens?.get(tokenId);
    if (token?.actor) return { actor: token.actor, sceneId: canvas.scene?.id ?? null, tokenId, actorId: token.actor.id, synthetic: true };
  }

  if (actorId) {
    const actor = game.actors.get(actorId);
    if (actor) return { actor, sceneId: null, tokenId: null, actorId: actor.id, synthetic: false };
  }

  return null;
}

function looksLikeDamageCard(message) {
  if (!message?.speaker?.actor) return false;
  const content = String(message.content ?? "").toLowerCase();
  const hasDamageWord = content.includes("dano") || content.includes("damage");
  const hasApplyWord = content.includes("aplicar") || content.includes("aplicado") || content.includes("apply");
  const hasRolls = Array.isArray(message.rolls) && message.rolls.length > 0;
  const hasSystemFlags = !!message.flags?.dnd5e || !!message.flags?.["hunter-system"] || !!message.flags?.hunterSystem;
  return (hasDamageWord && hasApplyWord) || (hasDamageWord && hasRolls) || (hasDamageWord && hasSystemFlags);
}

async function rememberChatDamageSource(message) {
  if (!looksLikeDamageCard(message)) return;
  const source = getActorFromSpeaker(message);
  if (!source?.actor) return;
  const attacker = source.actor;
  const data = {
    time: Date.now(),
    baseActorId: message.speaker?.actor ?? attacker.id,
    sceneId: source.sceneId,
    tokenId: source.tokenId,
    alias: message.speaker?.alias ?? attacker.name,
    messageId: message.id,
    synthetic: source.synthetic
  };
  const flagOwner = game.actors.get(message.speaker?.actor) ?? game.actors.get(attacker.id) ?? attacker;
  try {
    await flagOwner.setFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE, data);
    console.log("Healing Blood | Card de dano registrado:", data.alias, data);
  } catch (error) {
    console.warn("Healing Blood | Falha ao registrar card de dano.", error);
  }
}

function resolveSourceActor(data) {
  if (!data) return null;
  if (data.sceneId && data.tokenId) {
    const scene = game.scenes.get(data.sceneId);
    const tokenDoc = scene?.tokens?.get(data.tokenId);
    if (tokenDoc?.actor) return tokenDoc.actor;
  }
  if (data.tokenId) {
    const token = canvas.tokens?.get(data.tokenId);
    if (token?.actor) return token.actor;
  }
  if (data.baseActorId) return game.actors.get(data.baseActorId) ?? null;
  return null;
}

function findRecentDamageSource(targetActor) {
  const now = Date.now();
  let best = null;
  for (const flagOwner of game.actors) {
    const data = flagOwner.getFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE);
    if (!data) continue;
    const age = now - Number(data.time || 0);
    if (age < 0 || age > RECENT_SOURCE_MS) continue;
    const attacker = resolveSourceActor(data);
    if (!attacker) continue;
    if (attacker.id === targetActor.id && !data.tokenId) continue;
    if (!best || Number(data.time || 0) > Number(best.data.time || 0)) best = { attacker, flagOwner, data };
  }
  return best;
}

async function consumeDamageSource(flagOwner) {
  try { await flagOwner?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE); } catch (_) {}
}

async function healDamageSource(attacker, targetActor, damage) {
  if (!attacker || !targetActor) return;
  damage = Math.max(0, Number(damage) || 0);
  const dice = Math.floor(damage / 7);
  if (dice <= 0) return;
  const roll = await new Roll(`${dice}d4`).evaluate();
  const effectiveHealing = await healActor(attacker, roll.total);
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    flavor: `<b>Healing Blood</b><br><b>${attacker.name}</b> fez ${targetActor.name} perder <b>${damage} PV</b>.<br>Healing Blood: <b>${dice}d4 = ${roll.total}</b><br>Cura efetiva: <b>${effectiveHealing} PV</b>.`
  });
  console.log(`Healing Blood | ${attacker.name} recuperou ${effectiveHealing} PV após causar ${damage} de dano em ${targetActor.name}.`);
}

Hooks.once("ready", () => {
  if (globalThis.HealingBloodAutomation?.active) {
    console.log("Healing Blood | Automação já carregada.");
    return;
  }

  console.log("Healing Blood | Iniciando automação v1.0.6...");

  const chatHook = Hooks.on("createChatMessage", async message => {
    await rememberChatDamageSource(message);
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
      console.log(`Healing Blood | Fonte localizada para ${actor.name}: ${source.attacker.name}.`, source.data);
      await healDamageSource(source.attacker, actor, amount);
      await consumeDamageSource(source.flagOwner);
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
      if (!actor || processed.has(actor.uuid)) continue;
      processed.add(actor.uuid);
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
        content: `<div class="chat-card"><h2>Healing Blood</h2><p><b>${actor.name}</b> sofreu <b>${damage} de dano</b> durante o turno.</p><p>Metade: <b>${halfDamage}</b><br>Mod. Agilidade: <b>${dexMod >= 0 ? "+" : ""}${dexMod}</b></p><hr><p>Recupera <b>${effectiveHealing} PV</b>.</p></div>`
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
    version: "1.0.6",
    chatHook,
    actorDamageHook,
    combatHook,
    effectUpdateHook,
    effectDeleteHook
  };

  ui.notifications.info("Healing Blood Automation v1.0.6 carregada.");
  console.log("Healing Blood | Automação v1.0.6 ativa.");
});
