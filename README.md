# Healing Blood Automation

Módulo para Foundry VTT v14 que automatiza a técnica **Healing Blood**.

## Instalação por Manifest

No Foundry VTT, abra **Add-on Modules > Install Module** e cole no campo **Manifest URL**:

`https://raw.githubusercontent.com/clinioniji7-sketch/healing-blood-automation/main/module.json`

Depois, ative **Healing Blood Automation** em **Manage Modules** dentro do mundo.

## Uso

O módulo fica carregado automaticamente e somente reage a atores que possuam um Active Effect habilitado chamado exatamente **Healing Blood**.

Enquanto o efeito estiver ativo, o dano recebido é acumulado. Ao fim de qualquer turno, o portador recupera `floor(dano acumulado / 2) + modificador de Destreza/Agilidade`, limitado ao PV máximo, e o contador é zerado.

Ao desativar ou remover o Active Effect, o dano acumulado pendente é apagado.

A identificação do atacante corpo a corpo depende das informações fornecidas pelo fluxo de dano do D&D5e e deve ser validada no ambiente de jogo.

## Compatibilidade

- Foundry VTT v14
- Sistema D&D5e
