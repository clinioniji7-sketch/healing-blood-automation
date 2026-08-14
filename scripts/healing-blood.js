const HB_EFFECT_NAME = "Healing Blood";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_SCOPE = "world";
const RECENT_ATTACK_MS = 10000;

const recentMeleeAttacks = [];

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

function isMeleeActivity(activity) {
  if (!activity) return false;
  const item = activity.item ?? activity.parent ?? null;
  const values = [
    activity.actionType,
    activity.system?.actionType,
    activity.attack?.type?.value,
    activity.system?.attack?.type?.value,
    item?.system?.actionType
  ].filter(v => v != null).map(v => String(v).toLowerCase());
  if (values.some(v => ["mwak", "msak", "melee"].includes(v))) return true;
  const attackType = activity.attack?.type?.value ?? activity.system?.attack?.type?.value ?? null;
  return ["melee", "mwak", "msak"].includes(String(attackType ?? "").toLowerCase());
}

function collectTargetActorIds(...sources) {
  const ids = new Set();
  const visit = value => {
    if (!value) return;
    if (typeof value === "string") {
      const actorMatch = value.match(/Actor\.([^.]+)/);
      if (actorMatch) ids.add(actorMatch[1]);
      const tokenActor = canvas.tokens?.placeables?.find(t => t.document?.uuid === value || t.uuid === value)?.actor;
      if (tokenActor?.id) ids.add(tokenActor.id);
      return;
    }
    if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value[Symbol.iterator] === "function" && typeof value !== "string") {
      try { for (const entry of value) visit(entry); return; } catch (_) {}
    }
    const actor = asActor(value);
    if (actor?.id) ids.add(actor.id);
    if (value.actorId) ids.add(value.actorId);
    if (value.actor?.id) ids.add(value.actor.id);
    if (value.token?.actor?.id) ids.add(value.token.actor.id);
    if (value.document?.actor?.id) ids.add(value.document.actor.id);
    for (const key of ["targets","target","targetUuids","targetUUIDs","targetIds","tokens"]) {
      if (value[key]) visit(value[key]);
    }
  };
  for (const source of sources) visit(source);
  return ids;
}

function purgeOldAttacks() {
  const cutoff = Date.now() - RECENT_ATTACK_MS;
  while (recentMeleeAttacks.length && recentMeleeAttacks[0].time < cutoff) recentMeleeAttacks.shift();
}

function rememberMeleeAttack(activity, usageConfig = {}, results = {}) {
  if (!isMeleeActivity(activity)) return;
  const attacker = asActor(activity) ?? asActor(activity.item) ?? activity.actor ?? activity.item?.actor ?? null;
  if (!attacker) return;
  const targetActorIds = collectTargetActorIds(
    usageConfig?.targets,
    usageConfig?.target,
    usageConfig?.targetUuids,
    results?.targets,
    results?.target,
    results?.targetUuids,
    results
  );
  recentMeleeAttacks.push({ time: Date.now(), attacker, targetActorIds, activity });
  purgeOldAttacks();
  console.log("Healing Blood | Ataque corpo a corpo registrado:", attacker.name, [...targetActorIds]);
}

function findRecentMeleeAttacker(targetActor) {
  purgeOldAttacks();
  const matching = [...recentMeleeAttacks].reverse().filter(entry =>
    entry.targetActorIds.size === 0 || entry.targetActorIds.has(targetActor.id)
  );
  return matching[0] ?? null;
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
    flavor: `<b>Healing Blood</b><br>${attacker.name} causou <b>${damage} de dano corpo a corpo</b> em ${targetActor.name}.<br>O sangue curativo concede <b>${dice}d4</b> de cura.<br>Resultado: <b>${roll.total}</b> | Cura efetiva: <b>${effectiveHealing} PV</b>.`
  });
  console.log(`Healing Blood | ${attacker.name} recuperou ${effectiveHealing} PV após causar ${damage} de dano corpo a corpo em ${targetActor.name}.`);
}

Hooks.once("ready", () => {
  if (globalThis.HealingBloodAutomation?.active) {
    console.log("Healing Blood | Automação já carregada.");
    return;
  }

  console.log("Healing Blood | Iniciando automação v1.0.2...");

  const activityHook = Hooks.on("dnd5e.postUseActivity", (activity, usageConfig = {}, results = {}) => {
    if (!game.user.isGM) return;
    rememberMeleeAttack(activity, usageConfig, results);
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

    const attack = findRecentMeleeAttacker(actor);
    if (attack?.attacker) {
      await healMeleeAttacker(attack.attacker, actor, amount);
      const index = recentMeleeAttacks.indexOf(attack);
      if (index >= 0) recentMeleeAttacks.splice(index, 1);
    }
  });

  const recentlyHealedApplications = new Map();

  const applyDamageHook = Hooks.on("dnd5e.applyDamage", async (actor, amount, options = {}) => {
    if (!game.user.isGM) return;
    if (!actor) return;
    if (!hasHealingBlood(actor)) return;

    amount = Math.max(0, Number(amount) || 0);
    if (amount <= 0) return;

    let attacker = options?.sourceActor ?? options?.source?.actor ?? options?.actor ?? asActor(options?.activity) ?? asActor(options?.item) ?? null;
    let activity = options?.activity ?? null;
    let item = options?.item ?? options?.sourceItem ?? options?.source?.item ?? null;

    if (typeof attacker === "string") {
      try { attacker = await fromUuid(attacker); } catch (_) { attacker = null; }
    }
    if (typeof item === "string") {
      try { item = await fromUuid(item); } catch (_) { item = null; }
    }

    attacker = asActor(attacker) ?? attacker;
    let melee = isMeleeActivity(activity);
    if (!melee && item) {
      const actionType = String(item?.system?.actionType ?? "").toLowerCase();
      melee = ["mwak", "msak"].includes(actionType);
    }
    if (!attacker || !melee) return;

    const key = `${actor.id}:${attacker.id}:${amount}`;
    const last = recentlyHealedApplications.get(key) ?? 0;
    if (Date.now() - last < 1000) return;

    recentlyHealedApplications.set(key, Date.now());
    setTimeout(() => recentlyHealedApplications.delete(key), 1500);
    await healMeleeAttacker(attacker, actor, amount);
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
    version: "1.0.2",
    activityHook,
    actorDamageHook,
    applyDamageHook,
    combatHook,
    effectUpdateHook,
    effectDeleteHook
  };

  ui.notifications.info("Healing Blood Automation v1.0.2 carregada.");
  console.log("Healing Blood | Automação v1.0.2 ativa.");
});