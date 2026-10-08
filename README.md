# Dit Harry

**Mon journal intime vocal.** Je parle, Dit Harry transcrit, résume, repère mon humeur et
range tout dans mon Google Drive. (*Dit Harry*, comme *diary*.)

Application web installable (PWA) pensée pour **Android / Chrome**, entièrement en français,
pour un seul utilisateur. Pas de serveur : un site statique sur GitHub Pages, mes données
dans **mon** Google Drive, l'IA de **Google Gemini** avec **ma** clé.

## Fonctionnalités

- **Dictée** : un gros bouton pour enregistrer (jusqu'à 30 min), anneau qui suit la voix, chrono.
  L'enregistrement est sauvegardé au fil de l'eau : rien n'est perdu si le téléphone coupe.
- **Saisie au clavier** possible pour les jours où parler n'est pas pratique.
- **Analyse de chaque entrée** par Gemini : transcription nettoyée (sans les « euh »), titre,
  résumé, humeur (de -2 à +2), thèmes, personnes, lieux, choses à faire.
- **Correction** de la transcription à la main, puis nouvelle analyse automatique.
- **Synthèse du jour** générée automatiquement à la première ouverture du lendemain
  (ou tout de suite avec « Générer maintenant »).
- **Journal** : bande d'humeur des 30 derniers jours, liste des journées, détail de chaque jour.
- **Hors ligne** : on peut enregistrer sans réseau ; tout part dès que la connexion revient.
- **Sauvegarde** double : copie Markdown automatique et lisible dans un dossier Drive
  « Dit Harry », et export zip à la demande.
- **Audio conservé 365 jours** (réglable), puis supprimé automatiquement ; le texte reste.
- **Verrouillage** facultatif par **empreinte** (clé d'accès du téléphone, vérifiée sans
  serveur) avec une **phrase de secours** : l'appli se verrouille après un délai hors de l'appli
  (immédiat, 1, 5 ou 15 min) ou 5 min sans toucher l'écran, jamais pendant un enregistrement
  ni pendant l'écoute d'une entrée (l'écoute se met en pause au verrouillage).
- Thèmes clair et sombre ; aucun rappel ni notification.

## Comment ça marche

```
  Téléphone Android : Chrome / appli installée
  +--------------------------------------------------------------+
  |  Dit Harry (site statique servi par GitHub Pages)            |
  |                                                              |
  |  micro --> morceaux audio --> IndexedDB (sur le téléphone)   |
  |                                   |                          |
  |                     moteur de synchronisation                |
  |        analyse -> envoi -> synthèse -> ménage -> copie .md   |
  +-------------+--------------------------------+---------------+
                |                                |
     audio ou texte + clé Gemini      jeton Google (1 h, en mémoire)
                |                                |
                v                                v
     +---------------------+     +--------------------------------------+
     |  API Gemini         |     |  Google Drive                        |
     |  transcription,     |     |  - dossier caché de l'appli :        |
     |  analyse,           |     |    entrées (JSON), audio, synthèses, |
     |  synthèse du jour   |     |    réglages                          |
     +---------------------+     |  - Mon Drive/Dit Harry/AAAA/         |
                                 |    AAAA-MM-JJ.md (copie lisible)     |
                                 +--------------------------------------+
```

1. J'enregistre : l'audio est découpé en morceaux enregistrés au fur et à mesure sur le téléphone.
2. La synchronisation envoie l'audio à Gemini (en ligne, en un seul appel) qui renvoie la
   transcription et l'analyse ; l'entrée et l'audio sont ensuite déposés dans le Drive.
3. Le lendemain, la synthèse de la veille est générée, et la copie Markdown du jour est mise à jour.
4. Sur un autre appareil, il suffit de se connecter : tout est relu depuis le Drive.

## Confidentialité

- **Aucun serveur à moi, aucun traceur, aucune publicité.** Le site est statique ; il parle
  directement à Google Drive et à Gemini depuis le navigateur. Une politique de sécurité du
  contenu (CSP) stricte limite les origines autorisées.
- **Données dans mon Drive** :
  - le **dossier caché de l'application** (`appDataFolder`, autorisation `drive.appdata`) contient
    les entrées, l'audio, les synthèses et les réglages. Il n'apparaît pas dans l'interface de
    Drive et seule Dit Harry peut le lire. Pour tout effacer : Drive sur le web → Paramètres →
    Gérer les applications → Dit Harry → Options → « Supprimer les données d'application masquées » ;
  - la **copie lisible** en Markdown dans `Mon Drive/Dit Harry/` (autorisation `drive.file` :
    l'appli ne voit que les fichiers qu'elle a créés, **pas le reste de mon Drive**).
- **Gemini** : l'audio et le texte de chaque entrée sont envoyés à l'API Gemini (appel
  `generateContent`, audio joint directement à la requête, sans passer par l'API Files de Gemini).
  J'utilise l'**offre gratuite**, et j'accepte ses conditions : d'après les
  [conditions de l'API Gemini](https://ai.google.dev/gemini-api/terms), pour les services
  gratuits, Google peut utiliser les contenus pour améliorer ses produits et des personnes
  peuvent les relire ; Google conseille de ne pas y envoyer d'informations sensibles.
  **Nuance importante** : ces mêmes conditions précisent que pour les utilisateurs situés dans
  l'Espace économique européen, en Suisse ou au Royaume-Uni, ce sont les règles des services
  **payants** qui s'appliquent à tous les services, offre gratuite comprise (contenus non
  utilisés pour améliorer les produits ; journalisation limitée à la détection des abus).
  À revérifier de temps en temps : les conditions évoluent (version consultée : avril 2026).
- **Clé Gemini** : saisie dans l'appli, jamais dans le code ni dans le dépôt. Elle est stockée
  sur le téléphone (IndexedDB) et dans `settings.json` du dossier caché du Drive, pour la
  retrouver sur un autre appareil. En cas de doute, la supprimer dans
  [Google AI Studio](https://aistudio.google.com/apikey) et en créer une autre.
- **Connexion Google** : jeton d'accès valable 1 h, gardé en mémoire de session, jamais écrit
  dans le Drive ni dans IndexedDB. Pas de jeton de rafraîchissement (pas de serveur) : après
  une heure, l'appli propose « Se reconnecter ».
- **Verrouillage** : il protège l'affichage contre quelqu'un qui tient le téléphone déverrouillé.
  Ce n'est pas un chiffrement : la copie Markdown du Drive reste lisible, et les données locales
  restent accessibles aux outils de développement. Le code du téléphone ouvre aussi l'appli (il
  remplace l'empreinte), et qui tient le téléphone peut effacer les données du site puis se
  reconnecter à Google pour retrouver le journal. Sa configuration (clé publique, empreinte
  PBKDF2 de la phrase de secours) reste sur le téléphone, jamais dans le Drive. Détails dans
  [docs/SETUP.md](docs/SETUP.md) (étape 8).

## Développement

Prérequis : Node.js 22.12 ou plus récent.

```sh
npm install

# Mode démo : aucun compte Google ni clé Gemini, tout est simulé
npm run dev:mock          # http://localhost:5173

# Avec le vrai Google : identifiant client OAuth dans .env.local (voir docs/SETUP.md)
cp .env.example .env.local
npm run dev               # http://localhost:5173 (ce port précis est autorisé côté Google)

npm test                  # tests Vitest (Node + fake-indexeddb)
npm run check             # vérification des types (svelte-check, avertissements = erreurs)
npm run build             # construit le site dans dist/
npm run preview           # sert dist/ en local
npm run icons             # régénère les icônes (public/icons/)
```

### Mode démo

`npm run dev:mock` lance l'appli avec des services simulés : connexion instantanée
(compte `demo@exemple.fr`), faux Google Drive conservé dans IndexedDB
(`dit-harry-mock-drive`), Gemini simulé (environ 0,8 s par appel, analyse déterministe tirée
du texte, transcription factice pour l'audio). La base locale de la démo (`dit-harry-demo`)
est séparée de celle du vrai mode. Au premier lancement, trois entrées d'exemple sont
déposées sur des jours passés : leurs synthèses se génèrent toutes seules.

- N'importe quelle clé Gemini est acceptée ; tant qu'aucune n'est saisie, l'écran
  « clé manquante » s'affiche, comme en vrai.
- Le vrai micro est utilisé s'il est disponible, sinon un enregistrement simulé (silence)
  prend le relais.
- Le verrouillage fonctionne avec une empreinte simulée (« Déverrouiller (démo) », reconnue en
  une demi-seconde) ; la phrase de secours est la vraie.
- Pour repartir de zéro : DevTools → Application → Storage → « Clear site data ».

### Déploiement

Chaque push sur `main` lance [la GitHub Action](.github/workflows/deploy.yml) : tests,
vérification des types, construction, puis publication sur GitHub Pages. Le service worker
est renuméroté à chaque déploiement ; l'appli installée se met à jour à l'ouverture suivante.

La mise en place complète (dépôt GitHub, projet Google Cloud, clé Gemini,
installation sur Android) est décrite pas à pas dans **[docs/SETUP.md](docs/SETUP.md)**.

## Structure du projet

```
src/
  main.ts, App.svelte, app.css     montage, routage (#/…), styles
  components/                      écrans et composants Svelte
  config.ts                        configuration publique (modèles, scopes, limites)
  lib/
    types.ts, errors.ts, util.ts   contrat partagé, erreurs, utilitaires
    app.svelte.ts                  contrôleur réactif de l'interface
    lock.ts, lock.svelte.ts        verrouillage (empreinte WebAuthn, phrase de secours)
    passkey.ts                     clé d'accès : navigator.credentials (ou simulée en démo)
    db.ts, settings.ts             IndexedDB, réglages
    sync.ts                        moteur de synchronisation
    auth.ts, drive.ts              Google Identity Services, Drive REST v3
    gemini.ts, prompts.ts          client Gemini, prompts et schémas JSON
    recorder.ts                    enregistrement (MediaRecorder)
    markdown.ts, zip.ts, backup.ts copie Markdown, export zip
    services.ts                    assemblage des services (réels ou démo)
    mock/                          services simulés du mode démo
public/
  sw.js, manifest.webmanifest      service worker et manifeste PWA
  icons/                           icônes (générées par scripts/gen-icons.mjs)
tests/                             tests Vitest
docs/
  SPEC.md                          spécification technique
  SETUP.md                         guide d'installation pas à pas
.github/workflows/deploy.yml       déploiement GitHub Pages
```

## Documentation

- [docs/SETUP.md](docs/SETUP.md) : mise en place, de zéro jusqu'à l'appli sur le téléphone.
- [docs/SPEC.md](docs/SPEC.md) : spécification technique (comportements, stockage, synchronisation).
