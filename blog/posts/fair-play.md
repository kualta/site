---
title: "fair play"
description: "the art of online games balance"
date: "2021-07-08"
tags: ["game-design", "english"]
preview: "/images/fair-play-preview.png"
---

# The art of online games balance

![/images/fair-play-preview.png](/images/fair-play-preview.png)

## Abstract
Multiplayer games have been a popular form of entertainment for centuries, with thousands of games designed and played throughout human history. One essential aspect of any game is the presence of rules, which define the game space and balance players' experiences. While players may start with different initial conditions, fairness is a fundamental requirement of any game.

In this article we'll try to categorize existing multiplayer experiences based on their rule sets and explain how games in these categories might be balanced by the game designer.

In particular, this article seeks to address the question of whether it is possible to create a fair gaming experience for players with vastly different initial conditions.

This article will not focus on balancing game mechanics, but rather on balancing the rule sets that define the game space.

- [Chapter 13, p.203] Symmetrical Games
    > One quality that players universally seek in games is fairness. Players want to feel that the forces working against them do not have an advantage that will make them impossible to defeat. One of the simplest ways to ensure this is to make your game symmetrical, that is, to give equal resources and powers to all players. Most traditional board games (such as checkers, chess, and Monopoly) and almost all sports use this method to be sure that no player has an unfair advantage over another. If you want to put players in direct competition with each other and you expect them to have roughly equal levels of skill, symmetrical games are a great choice. They are particularly good systems for determining which player is the best, since all things in the game are equal but for the skill and strategy that the individual players bring to the game.

- [Chapter 13, p.203] Asymmetrical Games
    > It is also possible, and often desirable, to give opponents different resources and abilities. If you do, be aware that you have a significant balancing task ahead of you! Here are some of the reasons you might create an asymmetrical game:
    >
    > 1. To simulate a real-world situation: If the point of your game is to simulate the battle between Axis and Allied forces during World War II, a symmetrical game does not make sense, since the real-world conflict was not symmetrical.
    >
    > 2. To give players another way to explore the game space: Exploration is one of the great pleasures of gameplay. Players often enjoy exploring the possibilities of playing the same game with different powers and resources. In a fighting game, for example, if two players have ten different fighters to choose from, each with different powers, there are ten times ten different pairings, each of which requires different strategies, and effectively you have turned one game into one hundred games.
    > 
    > 3. Personalization: Different players bring different skills to a game—if you give the players a choice of powers and resources that best match their own skills, it makes them feel powerful—they have been able to shape the game to emphasize the thing they are best at.
    > 
    > 4. To level the playing field: Sometimes, your opponents have radically different skill levels. This is especially true if you have opponents that are computer controlled. \<...\>
    >
    > 5. To create interesting situations: In the infinite space of all the games that can be created, many more of them are asymmetrical than are symmetrical \<...\>
    >
    > It can be quite difficult to properly adjust the resources and powers in an asymmetrical game to make them feel evenly matched. The most common method of doing so is to assign a value to each resource or power and make sure that the sum of the values is equal for both sides. \<...\>

- [Chapter 12, p.182] Real vs. Virtual Skills
    > It is important to draw a distinction here: When we talk about skill as a game mechanic, we are talking about a real skill the player must have. In videogames, it is common to talk about your character's skill level. You might hear a player announce "My warrior just gained two points on his sword fighting skill!" But "sword fighting" is not a real skill required of the player—the player is really just pushing the right buttons on the control pad at the right time. Sword fighting, in this context, is a virtual skill—one that the player is pretending to have. The interesting thing about virtual skills is that they can improve even though the player's actual skill does not. The player might be just as sloppy at mashing the controller buttons as he ever was, but by mashing them enough times, he might be rewarded with a higher level of virtual skill, which allows his character to become a faster, more powerful swordfighter \<…\>

## Main part

We could try to split all existing experiences into two genres, or, more strictly speaking, _types of play_ these games provide.

### **Fair Play**
Fair play is a _symmetric_ at the start type of multiplayer game where powers and abilities are the same for each and every player and fairness of the game is close to absolute. The main deciding factor of these games is players _real skills_, such as reaction time, reflexes, strategical thinking etc.Therefore you'll often find PvP games use this type.
 Examples of such games are: Counter Strike series, Quake series and Chess. Fair play games usually require very little balancing, since players have the same initial conditions.

 It's important to understand that any fair play game might get a certain degree of asymmetry down the road. What matters is the starting possibilities are fair for every player, so that from the beginning anyone could make their way to victory with their _real skills_.

### **Madness Play**
Madness play is an _asymmetric_ type of game where players initial conditions may vary greatly. I found this name very fitting for this genre, since possibilities in this genre are only limited by the designer's imagination. Thus, madness play usually tends to have a possibility of providing player with unique, not available for everybody, experiences. For example, give a high-level mage a powerful spell, and here you have a _unique experience_ for a small portion of players.

By creating an experience like this, game designer might also use it to create _real in-game values_. Such as, for example, the staff that gets to cast the spell. Owning a staff like this shrinks the circle of players that could use the spell even more, not only limiting it by level, but also by the item possession itself, thus, making the staff valuable. Managing the _real in-game values_ is an entirely different topic however, which goes out of the scope of this article.

Simple example of this type might be any RPG game like Monster Hunter or Final Fantasy. Creating madness play for PvE experiences is fun and easy, since we do not care about the feelings of NPCs (perhaps we should!) and the player might get as strong and overbuffed as you wish. In fact, some game designers would want to create the entire game this way, providing player with feeling of being powerful. However, things get a lot more complicated if we switch from PvE experiences to PvP ones.

Imagine an online PvP game with RPG PvE item system being added to it. Lets say, items might vary their stats depending on their level. And we also want to create unique scenarios based on different items abilities. If you try to make this work the resulting experience risk to be highly unfair towards weaker players, obviously. Therefore, tweaks must be applied to this genre to actually make it playable.

 One popular approach to make madness play more _symmetric_ that has been used for a long time is nerfing player stats based on other player's level or the opposite, buffing other players to match the stronger player. This method might be not the best option for the stronger player themselves, because they are forced to play with lowered stats for the sake of fairness, or other players get a chance to play on the same level with them which is also not fair, which might ruin the player's experience. Plus, this method relies heavily on the balancing system being very nicely tuned. This technique is heavily used in MMORPGs and several other genres, and doesn't really work in reality, giving headaches to both player and developer

Another approach to this is to change players abilities completely, for example, by mirroring them. While this might work in some cases, it is already a change of subject due to game being not almost not the same as we had at the start, so we'll skip it.

## **Conclusion Solution**
I must conclude that it is _impossible_ to create a completely fair _madness play_ (I would love to be proved wrong here!), while not losing any of the advantages this genre brings to the table (providing player with _unique experiences_ & creating _real in-game values_)

To find a solution we first have to understand how _madness play_ differs from _fair play_. The core difference between the genres would be that the first makes use of player's _real skills_ and the result of the game is determined by them, while the second one often gives the player lots of _virtual skills_, and doesn't ask for much in return. You might already see the way we're going.

### Mad-fair play
In fact, solution for this problem has existed for over three decades now and is fairly well-known as part of regular game design cycle, I am talking about game's challenge. However, it has never been used to solve a problem like this. So let's give this phenomenon a name and call it a _ **unique challenge** _.

We might provide **unique experiences** by utilizing player's **real skills** via different **unique challenges**

But what is a "unique challenge"? To understand that we should come back to "The Art of Game Design" and see what author has to say about regular challenges in games

![/images/unique_challenge.png](/images/unique_challenge.png)

This diagram shows how Jesse describes player's mind flow in chapter 10, showing the direct dependence of player's skills with the amount of challenge they need to remain interested in the game.

To describe our concept a similar diagram might be useful, so let's modify it a little:

First off, notice how new **Experience Uniqueness** axis lays inside the "flow channel". That makes a lot of sense, since we surely do not want our new experiences to be boring nor give the player anxiety. The new **Unique Challenge** axis lays horizontally and two of them together establish elegant dependencies on each of the other axis: 

![/images/unique_challenge2.png](/images/unique_challenge2.png)

- Harder unique challenges require better _real skills_ from player
- Since the main challenge level is usually determined, unique challenges always lay on the same height at which they begin. We might mark a point on challenges axis which shows where it happens and call it dC
- The harder unique challenge is, the more unusual the result might be
- And the most important of the axis relationship: the more _real skills_ was required, the more unique the resulting experience will be. Bingo! That's exactly what we wanted to accomplish

But not all of the experiences have to be determined to their skill levels, this way we'll lower the entry point of the game for new players and create the "regular pool" of lets say, abilities, which new and not looking for additional challenge players may use to enjoy the game at their own pace. Let's mark this skill point and call it dS.

Now take a look at the gray rectangle these marks form. This would be the aforementioned "regular pool" area. Notice how not entire pool lays within the flow channel. That might seem like a bad thing at first, but it may also motivate casual players to leave the area of the regular pool and to improve their skills at the game.

This simple chart describes the concept of _mad-fair play_ entirely, which shows how powerful the idea really is. But to get a better grasp on it, let's try to describe how this idea may look like in the actual game.

For example let's take the Reaper's teleport ability from Overwatch. The way it works is extremely simple, you pick the ability by pressing E, and then pick a place to teleport to with your mouse. Then your character enters a preparation posture and teleports to the destination with a pretty loud sound, giving your opponents know where they might expect you from (an example of an actual mechanic balance in a fair play game). The way we could make this mechanic more interesting and unique for better players is to, for example, give the player a chance to complete a sequence of quick time events (QTE). Each would be harder to get than the previous one. The first success could remove paralyzing stance at the beginning of the ability. The second one could make the teleportation process faster. The third one could remove the loud teleportation sounds, therefore giving you a fair advantage in the game. 

![/images/reaper-tp.png](/images/reaper-tp.png)

I hope this quick example of using the concept of _unique challenges_ helped you get the idea better. But don't hung up on QTE only! The best thing about mad-fair play is that the sky is the limit for different challenges you might put player through, and that's where game designer could become a real artist.