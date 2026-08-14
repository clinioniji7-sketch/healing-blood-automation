const HB_EFFECT_NAME = "Healing Blood";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_ATTACK = "healingBloodLastAttack";
const HB_FLAG_SCOPE = "world";
const RECENT_ATTACK_MS = 15000;

function hasHealingBlood(actor) {
  if (!actor) return false;
  return actor.effects.some(effect =>
    !effect.disabled &&
    effect.name?.toLowerCase() === HB_EFFECT_NAME.toLowerCase()
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
  const missing = Math.max(0, hp.max - hp.value);
  const effective = Math.min(amount, missing);
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
  console.log(`Healing Blood | ${actor.name}: +${amount} dano acumulado (${current + amount} total).`);
}

async function clearDamage(actor) {
  if (!actor) return;
  try { await actor.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE); } catch (_) {}
}

function asActor(document) {
  if (!document) return null;
  if (document.documentName === "Actor") return document;
  if (document.actor) return document.actor;
  if (document.parent?.documentName === "Actor") return document.parent;
  if (document.item?.actor) return document.item.actor;
  return null;
}

function getActivityItem(activity) {
  return activity?.item ?? activity?.parent ?? null;
}

function isAttackActivity(activity) {
  if (!activity) return false;
  const values = [activity.type, activity.constructor?.name, activity.system?.type]
    .filter(Boolean)
    .map(v => String(v).toLowerCase());
  return values.some(v => v.includes("attack"));
}

function isMeleeActivity(activity) {
  if (!activity) return false;
  const item = getActivityItem(activity);
  const values = [
    activity.actionType,
    activity.system?.actionType,
    activity.attack?.type,
    activity.attack?.type?.value,
    activity.system?.attack?.type,
    activity.system?.attack?.type?.value,
    activity.range?.units,
    activity.system?.range?.units,
    item?.system?.actionType
  ].filter(v => v !== null && v !== undefined).map(v => String(v).toLowerCase());
  if (values.some(v => ["mwak", "msak", "melee", "touch"].includes(v))) return true;
  if (values.some(v => v.includes("melee"))) return true;
  if (isAttackActivity(activity)) {
    const range = Number(activity.range?.value ?? activity.system?.range?.value ?? item?.system?.range?.value);
    if (Number.isFinite(range) && range > 0 && range <= 5) return true;
  }
  return false;
}

function collectTargetActorIds(...sources) {
  const ids = new Set();
  const visit = value => {
    if (!value) return;
    if (typeof value === "string") {
      const actorMatch = value.match(/Actor\.([^.]+)/);
      if (actorMatch) ids.add(actorMatch[1]);
      const token = canvas.tokens?.placeables?.find(t => t.document?.uuid === value || t.uuid === value || t.id === value);
      if (token?.actor?.id) ids.add(token.actor.id);
      return;
    }
    if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== "string" && typeof value?.[Symbol.iterator] === "function") {
      try { for (const entry of value) visit(entry); return; } catch (_) {}
    }
    const actor = asActor(value);
    if (actor?.id) ids.add(actor.id);
    if (value.actorId) ids.add(value.actorId);
    if (value.actor?.id) ids.add(value.actor.id);
    if (value.token?.actor?.id) ids.add(value.token.actor.id);
    if (value.document?.actor?.id) ids.add(value.document.actor.id);
    for (const key of ["targets", "target", "targetUuids", "targetUUIDs", "targetIds", "tokens"]) {
      if (value[key]) visit(value[key]);
    }
  };
  for (const source of sources) visit(source);
  return ids;
}

async function rememberAttackOnActor(activity, usageConfig = {}, results = {}) {
  if (!isMeleeActivity(activity)) {
    console.log("Healing Blood | Atividade ignorada por não ser corpo a corpo:", activity);
    return;
  }
  const attacker = asActor(activity) ?? asActor(getActivityItem(activity)) ?? activity.actor ?? getActivityItem(activity)?.actor ?? null;
  if (!attacker) return;
  const targets = collectTargetActorIds(
    usageConfig?.targets,
    usageConfig?.target,
    usageConfig?.targetUuids,
    results?.targets,
    results?.target,
    results?.targetUuids,
    results,
    game.user.targets
  );
  const data = {
    time: Date.now(),
    attackerId: attacker.id,
    attackerUuid: attacker.uuid,
    targetActorIds: [...targets],
    activityName: activity.name ?? getActivityItem(activity)?.name ?? "Ataque"
  };
  try {
    await attacker.setFlag(HB_FLAG_SCOPE, HB_FLAG_ATTACK, data);
    console.log("Healing Blood | Ataque corpo a corpo registrado:", attacker.name, data);
  } catch (error) {
    console.warn("Healing Blood | Não foi possível registrar ataque no Actor.", error);
  }
}

function findRecentAttacker(targetActor) {
  if (!targetActor) return null;
  const now = Date.now();
  let best = null;
  for (const attacker of game.actors) {
    const data = attacker.getFlag(HB_FLAG_SCOPE, HB_FLAG_ATTACK);
    if (!data) continue;
    const age = now - Number(data.time || 0);
    if (age < 0 || age > RECENT_ATTACK_MS) continue;
    const targets = Array.isArray(data.targetActorIds) ? data.targetActorIds : [];
    if (targets.length > 0 && !targets.includes(targetActor.id)) continue;
    if (!best || Number(data.time || 0) > Number(best.data.time || 0)) best = { attacker, data };
  }
  return best;
}

async function consumeAttackRecord(attacker) {
  if (!attacker) return;
  try { await attacker.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_ATTACK); } catch (_) {}
}

async function healMeleeAttacker(attacker, targetActor, damage) {
  if (!attacker || !targetActor) return;
  if (attacker.id === targetActor.id) return;
  damage = Math.max(0, Number(damage) || 0);
  const dice = Math.floor(damage / 7);
  if (dice <= 0) return;
  const roll = await new Roll(`${dice}d4`).evaluate();
  const effectiveHealing = await healActor(attacker, roll.total);
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    flavor: `<b>Healing Blood</b><br>${attacker.name} causou <b>${damage} de dano corpo a corpo</b> em ${targetActor.name}.<br>Para cada 7 de dano, o sangue curativo concede 1d4.<br>Cura: <b>${dice}d4 = ${roll.total}</b><br>Cura efetiva: <b>${effectiveHealing} PV</b>.`
  });
  console.log(`Healing Blood | ${attacker.name} recuperou ${effectiveHealing} PV após causar ${damage} de dano em ${targetActor.name}.`);
}

Hooks.once("ready", () => {
  if (globalThis.HealingBloodAutomation?.active) {
    console.log("Healing Blood | Automação já carregada.");
    return;
  }

  console.log("Healing Blood | Iniciando automação v1.0.3...");

  const activityHook = Hooks.on("dnd5e.postUseActivity", async (activity, usageConfig = {}, results = {}) => {
    await rememberAttackOnActor(activity, usageConfig, results);
  });

  const actorDamageHook = Hooks.on("dnd5e.damageActor", async (actor, changes = {}, update = {}, userId) => {
    if (!game.user.isGM) return;
    if (!actor) return;
    if (!hasHealingBlood(actor)) return;

    let amount = Math.abs(Number(changes?.total) || 0);
    if (amount <= 0) {
      const hpLoss = Math.min(0, Number(changes?.hp) || 0);
      const tempLoss = Math.min(0, Number(changes?.temp) || 0);
      amount = Math.abs(hpLoss + tempLoss);
    }
    if (amount <= 0) return;

    await accumulateDamage(actor, amount);

    const attack = findRecentAttacker(actor);
    if (attack?.attacker) {
      await healMeleeAttacker(attack.attacker, actor, amount);
      await consumeAttackRecord(attack.attacker);
    } else {
      console.log(`Healing Blood | ${actor.name} sofreu ${amount}, mas nenhum atacante corpo a corpo recente foi associado.`);
    }
  });

  const combatHook = Hooks.on("updateCombat", async (combat, changed) => {
    if (!game.user.isGM) return;
    const turnChanged = Object.prototype.hasOwnProperty.call(changed, "turn");
    const roundChanged = Object.prototype.hasOwnProperty.call(changed, "round");
    if (!turnChanged && !roundChanged) return;

    const processedActors = new Set();
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;
      if (processedActors.has(actor.id)) continue;
      processedActors.add(actor.id);
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
        content: `<div class="chat-card"><h2>Healing Blood</h2><p><b>${actor.name}</b> sofreu <b>${damage} de dano</b> durante o turno.</p><p>Metade do dano: <b>${halfDamage}</b><br>Mod. Agilidade: <b>${dexMod >= 0 ? "+" : ""}${dexMod}</b></p><hr><p>Recupera <b>${effectiveHealing} PV</b>.</p></div>`
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
    version: "1.0.3",
    activityHook,
    actorDamageHook,
    combatHook,
    effectUpdateHook,
    effectDeleteHook
  };

  ui.notifications.info("Healing Blood Automation v1.0.3 carregada.");
  console.log("Healing Blood | Automação v1.0.3 ativa.");
});
