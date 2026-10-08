# Mettre en place Dit Harry, pas à pas

Ce guide part de zéro et va jusqu'à l'appli installée sur le téléphone Android. Compter
environ 45 minutes la première fois. Libellés vérifiés en octobre 2026 ; les consoles Google
et GitHub changent parfois de présentation, mais les noms des pages restent proches.

Dans tout le guide, **`<org>`** désigne le nom de l'organisation GitHub choisie à l'étape 1
(par exemple `dit-harry`). L'appli sera publiée sur **`https://<org>.github.io/`**.

**Il te faut :**

- un compte GitHub ;
- un compte Google (celui dont le Drive accueillera le journal) ;
- un téléphone Android avec Chrome ;
- sur l'ordinateur : Git et, pour développer, Node.js 22.12 ou plus récent.

> Les consoles Google peuvent être en français ou en anglais. Le guide donne le libellé
> anglais (repère le plus stable) et, quand il est connu, le libellé français entre « ».

---

## 1. GitHub : une organisation dédiée et son dépôt

**Pourquoi une organisation ?** Tous les sites GitHub Pages d'un même compte sont servis
depuis la même origine `https://<compte>.github.io`. Ils partagent donc le stockage du
navigateur (IndexedDB, localStorage, service workers) et l'autorisation Google. Comme tu as
déjà d'autres sites, une organisation gratuite donne à Dit Harry sa propre origine,
`https://<org>.github.io`, isolée des autres.

1. Va sur <https://github.com/organizations/plan> (ou : ta photo en haut à droite →
   **Your organizations** → **New organization**).
2. Choisis l'offre **Free** (« Create a free organization »).
3. **Organization name** : par exemple `dit-harry` (s'il est pris, `dit-harry-<prénom>`…).
   Ce nom fera partie de l'adresse du site.
4. **Contact email** : ton email. **This organization belongs to** : *My personal account*.
   Valide, puis passe l'étape d'invitation de membres.
5. Dans l'organisation : **Repositories** → **New repository**.
   - **Repository name** : exactement **`<org>.github.io`** (ex. `dit-harry.github.io`).
   - **Public** (obligatoire pour GitHub Pages avec l'offre gratuite ; le code ne contient
     aucun secret).
   - Ne coche **ni** README, **ni** .gitignore, **ni** licence : le dépôt doit rester vide.
   - **Create repository**.

## 2. GitHub Pages : publier via GitHub Actions

Dans le dépôt : **Settings** → **Pages** (rubrique *Code and automation*) →
**Build and deployment** → **Source** : choisis **GitHub Actions**.

Rien d'autre à faire ici : le workflow `.github/workflows/deploy.yml` du projet se charge
de la construction et de la publication.

## 3. Google Cloud : projet, API Drive et connexion Google

### 3.1 Créer le projet

1. Ouvre <https://console.cloud.google.com/projectcreate> (accepte les conditions si c'est
   ta première visite).
2. **Project name** (« Nom du projet ») : `Dit Harry`. **Create** (« Créer »).
3. Vérifie en haut de la console que le projet **Dit Harry** est bien sélectionné : toutes
   les étapes suivantes s'appliquent au projet sélectionné.

### 3.2 Activer l'API Google Drive

Ouvre <https://console.cloud.google.com/apis/library/drive.googleapis.com> →
**Enable** (« Activer »).

### 3.3 Google Auth Platform : informations de l'application

1. Ouvre <https://console.cloud.google.com/auth/overview> (menu ☰ → **Google Auth Platform**).
2. Clique sur **Get started** (« Commencer »), puis remplis l'assistant :
   - **App Information** : **App name** = `Dit Harry` ; **User support email** = ton email → **Next**.
   - **Audience** : **External** (« Externe ») → **Next**.
   - **Contact Information** : ton email → **Next**.
   - **Finish** : accepte le règlement sur les données utilisateur des services d'API Google →
     **Continue**, puis **Create**.
3. Page **Branding** : ne mets **pas de logo**. Un logo oblige à faire valider la marque par
   Google (plusieurs jours) ; sans logo, tout fonctionne. Sans validation de la marque, l'écran
   de consentement peut afficher l'adresse du site plutôt que « Dit Harry » : c'est normal.

### 3.4 Data Access : déclarer les deux autorisations Drive

1. Ouvre <https://console.cloud.google.com/auth/scopes> (Google Auth Platform → **Data Access**).
2. **Add or remove scopes**. Tout en bas du panneau, dans **Manually add scopes**, colle ces
   deux lignes :

   ```
   https://www.googleapis.com/auth/drive.appdata
   https://www.googleapis.com/auth/drive.file
   ```

3. **Add to table** → vérifie qu'elles sont cochées → **Update**, puis **Save** en bas de la page.
4. Elles doivent apparaître sous **Your non-sensitive scopes** : ces deux autorisations sont
   classées « non sensibles » par Google, donc **aucune validation de l'appli n'est nécessaire**.
   - `drive.appdata` : le dossier caché propre à l'appli (entrées, audio, réglages) ;
   - `drive.file` : uniquement les fichiers créés par l'appli (la copie Markdown visible).

### 3.5 Audience : passer en production

1. Ouvre <https://console.cloud.google.com/auth/audience> (Google Auth Platform → **Audience**).
2. Sous **Publishing status** (statut **Testing**), clique sur **Publish app**, puis confirme.
   Le statut devient **In production**.

**Pourquoi ?** En mode *Testing*, Google fait expirer l'autorisation au bout de 7 jours et
il faudrait tout réaccepter chaque semaine. Comme l'appli n'utilise que des autorisations
non sensibles et n'a pas de logo, la mise en production ne demande aucune validation.

### 3.6 Clients : créer l'identifiant OAuth « Application Web »

1. Ouvre <https://console.cloud.google.com/auth/clients> (Google Auth Platform → **Clients**).
2. **Create client** (« Créer un client »).
3. **Application type** : **Web application** (« Application Web »). **Name** : `Dit Harry web`.
4. **Authorized JavaScript origins** (« Origines JavaScript autorisées ») → **Add URI**, trois fois :
   - `https://<org>.github.io` (ex. `https://dit-harry.github.io`) ;
   - `http://localhost:5173` et `http://localhost` (pour le développement sur l'ordinateur :
     la documentation Google demande les deux formes, avec et sans port).

   Attention : pas de `/` final, pas de chemin, `https` pour le site.
5. **Authorized redirect URIs** (« URI de redirection autorisés ») : **laisse vide**. L'appli
   utilise une fenêtre surgissante (popup) Google, sans redirection.
6. **Create**. Copie l'**ID client** (`…apps.googleusercontent.com`). Le **code secret du
   client** ne sert pas : ne le mets nulle part.

Google prévient que la prise en compte peut prendre **de 5 minutes à quelques heures**.

## 4. GitHub : enregistrer l'identifiant client

Dans le dépôt : **Settings** → **Secrets and variables** → **Actions** → onglet
**Variables** → **New repository variable** :

- **Name** : `GOOGLE_CLIENT_ID`
- **Value** : l'ID client copié à l'étape 3.6

C'est une *variable* et non un *secret* : l'ID client est public par nature (il est inclus
dans le site). Il n'y a aucun secret à stocker pour Dit Harry.

## 5. Envoyer le code et déployer

Depuis le dossier du projet, sur l'ordinateur :

```sh
git init -b main
git add .
git commit -m "Dit Harry v1"
git remote add origin https://github.com/<org>/<org>.github.io.git
git push -u origin main
```

Le push déclenche le workflow. Suis-le dans l'onglet **Actions** du dépôt
(« Déployer sur GitHub Pages ») : tests → vérification → construction → publication.
Au bout de 2 à 3 minutes, l'appli est en ligne sur **`https://<org>.github.io/`**.

- Pour relancer un déploiement sans modifier le code (par exemple après avoir changé la
  variable `GOOGLE_CLIENT_ID`) : **Actions** → « Déployer sur GitHub Pages » → **Run workflow**.
- Ensuite, chaque `git push` sur `main` redéploie automatiquement.

## 6. Clé Gemini

1. Ouvre <https://aistudio.google.com/apikey> avec ton compte Google et accepte les conditions.
2. **Create API key**. Choisis un projet : celui proposé par défaut par AI Studio convient, ou
   le projet « Dit Harry » (pour le voir, il faut d'abord l'importer : **Dashboard** →
   **Projects** → **Import projects**).
3. Copie la clé.
4. Dans Dit Harry (après connexion), l'écran **Clé Gemini** s'affiche : colle la clé →
   **Vérifier**. Plus tard, elle se modifie dans **Réglages** → Clé Gemini.

À savoir :

- La clé ne va **jamais** dans le dépôt, ni dans `.env.local`, ni dans un message. Elle est
  gardée sur le téléphone et dans le dossier caché du Drive (pour la retrouver sur un autre
  appareil). Google bloque rapidement les clés détectées comme divulguées.
- Depuis le 28 mai 2026, AI Studio crée des clés « auth keys » utilisables directement. Une
  ancienne clé « standard » doit être **restreinte à l'API Gemini** (dans AI Studio : survoler
  « Unrestricted » → **Add restrictions** → **Restrict to Gemini API only**), sinon Gemini la refuse.
- L'**offre gratuite** suffit (pas de facturation à activer). Elle a des limites de requêtes
  par minute et par jour, visibles dans AI Studio. Voir la section Confidentialité du
  [README](../README.md#confidentialité) pour l'usage des données.

## 7. Installer l'appli sur le téléphone Android

1. Sur le téléphone, ouvre **Chrome** à l'adresse `https://<org>.github.io/`.
2. **Se connecter avec Google** → choisis ton compte → sur l'écran d'autorisation, **coche les
   deux cases Google Drive** → **Continuer**.
3. Colle la clé Gemini (étape 6) si ce n'est pas déjà fait.
4. Menu **⋮** de Chrome → **Installer l'application** (ou **Ajouter à l'écran d'accueil** →
   **Installer**). L'icône Dit Harry apparaît sur l'écran d'accueil.
5. Ouvre Dit Harry depuis l'icône et fais un premier enregistrement : Chrome demande l'accès au
   **micro** → **Autoriser**.

Mises à jour : après un déploiement, l'appli se met à jour d'elle-même à l'ouverture suivante
(au besoin, la fermer complètement puis la rouvrir).

## 8. Développement sur l'ordinateur

```sh
npm install
npm run dev:mock      # démo sans Google ni Gemini : rien à configurer
```

Pour tester avec ton vrai compte Google :

```sh
cp .env.example .env.local
# puis, dans .env.local :
# VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
npm run dev           # http://localhost:5173
```

- `.env.local` est ignoré par Git. Il ne contient que l'ID client (public), jamais la clé Gemini.
- Le site doit tourner sur **`http://localhost:5173`** exactement (origine autorisée à
  l'étape 3.6). Si Vite annonce un autre port, c'est que 5173 est occupé : arrête l'autre
  serveur. Utilise `localhost`, pas `127.0.0.1`.
- Le mode démo et le vrai mode utilisent des bases locales différentes : pas de mélange.

## 9. En cas de problème

**Rien ne se passe en touchant « Se connecter » / popup bloquée.**
Chrome n'ouvre la fenêtre Google que juste après un appui. Réessaie en touchant une seule
fois le bouton. Si elle reste bloquée : Chrome **⋮** → **Paramètres** → **Paramètres des
sites** → **Pop-ups et redirections** → autoriser `<org>.github.io`.

**« Accès refusé », ou l'appli demande de cocher les deux autorisations.**
Google laisse décocher chaque autorisation : Dit Harry a besoin des **deux** cases Drive.
Reconnecte-toi et coche les deux. Si l'écran ne les propose plus : va sur
<https://myaccount.google.com/connections>, ouvre **Dit Harry**, supprime son accès, puis
reconnecte-toi depuis l'appli.

**« Erreur 400 : origin_mismatch ».**
L'adresse du site ne correspond pas aux origines autorisées du client OAuth (étape 3.6).
Vérifie l'orthographe exacte : `https://<org>.github.io` (sans `/` final) et, en local,
`http://localhost:5173`. Après une modification, attends quelques minutes (jusqu'à quelques
heures).

**« Accès bloqué » / l'appli n'est utilisable que par des testeurs.**
L'appli est encore en mode *Testing* : fais l'étape 3.5 (**Publish app**).

**Session expirée au bout d'une heure, bandeau « Se reconnecter ».**
C'est normal : sans serveur, Google ne délivre que des jetons d'une heure. Touche
**Se reconnecter** : la fenêtre Google s'ouvre et se referme seule. Les entrées enregistrées
entre-temps restent sur le téléphone et partent dès la reconnexion.

**Gemini : « quota dépassé » (erreur 429).**
Les limites de l'offre gratuite sont atteintes (par minute ou par jour). Rien n'est perdu :
l'appli réessaie toute seule plus tard. Les limites sont visibles dans AI Studio. Si cela
arrive souvent, choisis un modèle plus léger dans **Réglages**.

**Gemini : « clé refusée ».**
Vérifie la clé dans **Réglages** → **Vérifier**. Si c'est une ancienne clé standard, restreins-la
à l'API Gemini (étape 6) ou crée une nouvelle clé.

**Le déploiement échoue à l'étape « Configurer Pages ».**
GitHub Pages n'est pas réglé sur **GitHub Actions** (étape 2).

**Le déploiement est refusé : « … not allowed to deploy to github-pages due to environment
protection rules ».**
**Settings** → **Environments** → **github-pages** → **Deployment branches and tags** :
autorise la branche `main`.

**L'appli affiche « Identifiant client Google manquant ».**
La variable `GOOGLE_CLIENT_ID` (étape 4) est absente ou vide au moment du build : corrige-la
puis relance le workflow (**Run workflow**).

**« Ton Google Drive est plein ».**
Libère de la place dans Drive, ou réduis la durée de conservation de l'audio dans **Réglages**.
