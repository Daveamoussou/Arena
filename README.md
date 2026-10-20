# 🎮 Arène des jeux

Site de jeux en ligne : **Puissance 4** et **Pierre-Feuille-Ciseaux**, contre un autre joueur ou contre l'ordinateur (3 niveaux).
Node.js + Express + Socket.IO. Aucune base de données à installer (fichier JSON).

## Lancer
    npm install
    npm start          # http://localhost:3000
    npm test           # règles des jeux, ordinateur, comptes

## Fonctionnement
- **Inscription** : e-mail + pseudo + mot de passe (8 car. min.) + avatar. Toute personne ayant le lien peut s'inscrire.
- **Salon** : liste en temps réel des joueurs *libres*, avec recherche par pseudo.
- **Défi** : un clic sur « Défier » envoie automatiquement une invitation (valable 30 s). L'autre accepte ou refuse.
  Dès l'invitation, les deux joueurs disparaissent de la liste des libres ; ils y reviennent à la fin de la partie.
- **Contre l'ordinateur** : niveaux 1, 2, 3.
- Le serveur est l'arbitre : toutes les règles sont vérifiées côté serveur.

## Règles
**Puissance 4** : grille 7×6, on aligne 4 pions (ligne, colonne, diagonale). Celui qui commence est tiré au sort, la revanche inverse l'ordre. 30 s par coup contre un humain (coup au hasard si le temps est écoulé). Grille pleine = match nul.

**Pierre-Feuille-Ciseaux** : premier à **2 manches gagnées**. Égalité = manche rejouée. 15 s par manche contre un humain.

**Abandon / déconnexion** : quitter une partie en cours = défaite. En cas de coupure réseau, 30 s pour revenir.

## Niveaux de l'ordinateur
| | Puissance 4 | Pierre-Feuille-Ciseaux |
|---|---|---|
| 1 | coups au hasard | au hasard |
| 2 | gagne s'il peut, bloque le plus souvent, évite d'offrir une victoire | contre ton coup préféré récent (60 %) |
| 3 | minimax, profondeur 6 | repère tes enchaînements, contre ~85 % du temps |

L'ordinateur ne triche jamais : il joue avant de connaître ton coup.

## Déploiement (Render)
`render.yaml` est fourni. ⚠️ Sur l'offre gratuite le disque est éphémère : les comptes sont perdus à chaque redéploiement.
Pour les conserver : disque persistant + variable `DATA_FILE`, ou passer plus tard sur une vraie base (PostgreSQL).

## Sécurité
Mots de passe hachés (scrypt), jetons de session hachés, limitation des tentatives, en-têtes CSP stricts, aucune injection HTML côté client.
Pas de vérification de l'e-mail pour l'instant (aucun e-mail n'est envoyé).

## Application installable (PWA)
Une fois le site en ligne sur Render (HTTPS), il s'installe comme une application :
- **Android / Chrome** : menu ⋮ → « Installer l'application ».
- **iPhone / Safari** : Partager → « Sur l'écran d'accueil ».
- **Ordinateur (Chrome / Edge)** : icône d'installation dans la barre d'adresse.

Fichiers concernés : `public/manifest.webmanifest`, `public/sw.js`, `public/icons/`.
Les parties exigent une connexion internet (temps réel), seule l'interface est mise en cache.
