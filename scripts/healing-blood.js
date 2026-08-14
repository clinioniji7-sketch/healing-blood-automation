const HB_EFFECT_NAME = "Healing Blood";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_SCOPE = "world";

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
}

async function clearDamage(actor) {
  if (!actor) return;
  try {
    await actor.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE);
  } catch (_) {}
}

Hooks.once("ready", () => {
  if (globalThis.HealingBloodAutomation?.active) {
    console.log("Healing Blood | Automação já carregada.");
    return;
  }

  console.log("Healing Blood | Iniciando automação...");

  const damageHook = Hooks.on("dnd5e.applyDamage", async (actor, amount, options = {}) => {
    if (!game.user.isGM) return;
    if (!actor) return;
    amount = Number(amount) || 0;
    if (amount <= 0) return;
    if (!hasHealingBlood(actor)) return;

    await accumulateDamage(actor, amount);

    let attacker = options?.sourceActor ?? options?.source?.actor ?? options?.actor ?? null;
    let item = options?.item ?? options?.sourceItem ?? options?.source?.item ?? null;

    if (typeof attacker === "string") {
      try { attacker = await fromUuid(attacker); }
      catch (_) { attacker = null; }
    }
    if (typeof item === "string") {
      try { item = await fromUuid(item); }
      catch (_) { item = null; }
    }
    if (!attacker) return;

    let actionType = item?.system?.actionType ?? null;
    if (!actionType && item) {
      const activities = item.system?.activities;
      const firstActivity = activities?.contents?.[0] ?? activities?.[0] ?? null;
      actionType = firstActivity?.actionType ?? firstActivity?.system?.actionType ?? firstActivity?.type ?? null;
    }

    const isMelee = ["mwak", "msak"].includes(actionType);
    if (!isMelee) return;

    const dice = Math.floor(amount / 7);
    if (dice <= 0) return;

    const roll = await new Roll(`${dice}d4`).evaluate();
    const effectiveHealing = await healActor(attacker, roll.total);

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      flavor: `<b>Healing Blood</b><br>${attacker.name} causou <b>${amount} de dano corpo a corpo</b> em ${actor.name}.<br>Healing Blood concede <b>${dice}d4</b> de cura.<br>Cura efetiva: <b>${effectiveHealing} PV</b>.`
    });
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
        content: `<div class="chat-card"><h2>Healing Blood</h2><p><b>${actor.name}</b> sofreu <b>${damage} de dano</b> desde o último fim de turno.</p><p>Metade do dano: <b>${halfDamage}</b><br>Mod. Agilidade: <b>${dexMod >= 0 ? "+" : ""}${dexMod}</b></p><hr><p>Recupera <b>${effectiveHealing} PV</b>.</p></div>`
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
    damageHook,
    combatHook,
    effectUpdateHook,
    effectDeleteHook
  };

  ui.notifications.info("Healing Blood Automation carregada.");
  console.log("Healing Blood | Automação ativa.");
});
