---
title: "Fair Play"
description: "on multiplayer asymmetry"
date: "2021-07-08"
tags: ["game-design"]
preview: "/images/fair-play/preview.png"
---

![/images/fair-play/preview.png](/images/fair-play/preview.png)


## Preamble
This article discusses the challenge of creating balanced gameplay experiences in asymmetric online games, where players may start with vastly different initial conditions.

It describes the concept of mad-fair play, which involves creating unique challenges that leverage the player's real skills to create engaging gameplay experiences. By balancing the advantages of asymmetric games with the fairness of symmetric ones, mad-fair play offers a unique approach to game design that can appeal to a broad range of players.

Let's start by first categorizing existing multiplayer experiences based on their rule sets. All existing games can be split into two types. Let's call them fair play and madness play.

### Fair Play
Fair play is a type of multiplayer game where all players have the same powers and abilities. The fairness of the game is close to absolute. The main deciding factor of these games is players’ real skills, such as reaction time, reflexes and strategic thinking. You will often find PvP games use this type. Fair play games usually require little to no balancing, since players have the same initial conditions.

However, not all games are based on fair play. Some games introduce a certain degree of asymmetry between players. We'll call this type of games madness play.

### Madness Play
Madness play is an asymmetric game type, where players may start in vastly different conditions. The term madness play is fitting for this genre, as the possibilities it offers are limited only by the game designer's imagination. This allows for the creation of unique experiences for players.

For example, providing a high-level mage with a powerful spell creates a unique experience that only a small portion of players can enjoy. Designers can also leverage this to create in-game values, such as items like staffs, that enable players to cast powerful spells. These items not only limit access to the spell by player level but also by item possession, making them even more valuable.

Creating asymmetric PvE experiences is usually pretty straightforward, as the impact on non-playable characters is not a significant concern, and it allows game designers to empower players as much as they'd like.

## Problem
However, things get more complicated when we move from PvE experiences to PvP ones. Imagine an online PvP game that incorporates a PvE item system, where the stats of items vary depending on their level and unique experiences are created based on their virtual skills. Such a system risks being highly unfair towards weaker players, and adjustments must be made to ensure fairness of the gameplay.

One popular approach to achieving that balance is to nerf player stats based on the level of their opponents, or alternatively, buff weaker players to match stronger ones. This method might be not the best option for the stronger player themselves, because they are forced to play with lowered stats for the sake of fairness. Additionally, this approach relies heavily on the balancing system being finely tuned, which can be a monumental task on it's own. This technique is commonly used in MMORPGs and several other genres but has proven to be problematic in practice, resulting in frustration for both players and developers.

I must conclude that it is impossible to create a completely fair madness play (but I would love to be proved wrong here), while not losing any of the advantages this genre brings to the table (providing player with unique experiences & creating in-game values).

It is essential to comprehend the fundamental differences between madness play and fair play. The primary distinction between the two genres lies in the utilization of the player's real skills, which determine the outcome of the game, versus their virtual skils, that demands little to no effort, but allows to empower the player. Therefore, it is necessary to explore potential solutions that bridge this gap between real and virtual skills.

## Mad-fair Play
To address this issue, I propose the concept of a unique challenge that leverages the player's real skills to create unique gameplay experiences. To better understand this concept, let's refer to _"The Art of Game Design"_, chapter 10 of which describes the relationship between a player's skill level and the level of challenge required to maintain their interest in the game.

![/images/fair-play/unique-challenge.png](/images/fair-play/unique-challenge.png)

To illustrate the concept, let's modify Jesse's diagram in this chapter to include the challenge uniqueness axis within the flow channel. It lies there since we:
1. Need to continuously increase the amount of challenge required.
2. Aim to avoid monotony and anxiety-inducing gameplay experiences.
3. Want more unique experiences to require more of player's real skills

The chart presented above provides an overview of the mad-fair play concept and, since the new axis can go up to infinity, it shows-off its potential. To better explain the concept, let's imagine how it could be implemented in a real game.

Consider the Reaper's teleport ability in Overwatch. This usage of it is very straightforward: the player selects the ability using the E key and then chooses a location to teleport to. The player's character enters a preparation stance, and after a loud sound effect, teleports to the chosen location, making their presence known to their opponents. This mechanic is an example of a balanced gameplay element in a fair play game.

To make this mechanic more engaging and unique for skilled players, we might add a sequence of quick-time events (QTEs). Each QTE would progressively increase in difficulty, and successful completion would confer benefits to the player.

For example, the first successful QTE could remove the paralyzing stance at the start of the ability, the second could make the teleportation process faster, and the third could remove the loud teleportation sound, providing a player with a strategic advantage.

This illustrates the potential of unique challenges in enhancing gameplay experiences. However, it is essential to note that QTEs are just one example of how the mad-fair play could be implemented. The versatility of the concept allows game designers to create a wide range of challenges, utilizing any of the player's real skills.
