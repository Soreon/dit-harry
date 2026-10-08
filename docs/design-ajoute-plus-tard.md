# « Ajouté plus tard » / « Prévu » — dossier de conception

Ce fichier garde la conception retenue après comparaison de plusieurs propositions (« Recommended
design » ci-dessous). Le comportement livré est décrit dans `docs/SPEC.md` §16 ; là où les deux
diffèrent, ce sont les décisions finales ci-dessous qui s'appliquent.

## Décisions finales (utilisateur, 8 octobre 2026)

1. **Ajout automatique quand il n'y a pas d'ambiguïté** (hier, avant-hier, il y a N jours, jour de
   la semaine qui ne désigne qu'un jour, date explicite ; à venir : demain, après-demain, dans N
   jours, « lundi prochain » sans ambiguïté, « le 15 octobre »). Sinon (week-end, « hier » ou
   « demain » dit entre 0 h et 4 h, jour de la semaine ambigu, désaccord code / modèle, repère
   inconnu mais date du modèle) : **proposition** de 1 à 3 jours, choisie d'une touche (ou « Ne
   pas ajouter »). Périodes floues ignorées. Repère absent de la transcription → mention rejetée.
2. **L'avenir est inclus** (la conception l'excluait) : même mécanisme, `kind: 'future'`, note
   « 📌 Prévu » sur le jour visé, « Prévu aujourd'hui » sur l'écran Aujourd'hui, section « À venir »
   en tête du Journal (60 jours). Fenêtre : 31 jours avant, 60 jours après. Un seul tableau sur
   l'entrée : `analysis.mentions` (5 au plus), au lieu de `analysis.past`. La synthèse d'un jour
   reçoit ce qui était « prévu pour ce jour » avec l'interdiction de le présenter comme arrivé.
   Pas de fichier Markdown pour un jour à venir.
3. **Navigation dans les deux sens** : toucher une note sur le jour visé ouvre le jour de
   l'entrée source, entrée mise en évidence (`#/jour/<jour>?e=<entrée>`, défilement, contour,
   focus) ; l'entrée source liste ses rattachements (jour, statut, choisir, changer de jour,
   modifier, retirer / rétablir) et toucher l'un d'eux ouvre le jour visé, note mise en évidence
   (`&m=<mention>`).
4. **Synthèse du jour visé régénérée une seule fois**, le lendemain (signature = entrées + notes
   actives des deux genres), avec les verdicts nouveau / complète / déjà présent ; « déjà
   présent » replie la note sur « Tu y es revenu le … », jamais supprimée.
5. **Pas de déploiement par étapes** : tout est actif d'emblée ; la transparence vient de la liste
   sur l'entrée source. Réglage « Rattacher aux autres jours » (automatique par défaut / désactivé) :
   désactivé, rien n'est envoyé à Gemini et les notes existantes sont masquées (pas effacées). Le
   mode « Me demander » de la conception n'est pas retenu.
6. **Gestes de l'utilisateur** conservés à la ré-analyse, sans toucher `updatedAt` (pas de
   régénération du jour source) ; supprimer l'entrée source retire ses notes partout.
7. **Démo** : la fausse IA repère les expressions simples par expressions régulières.

Écarts de mise en œuvre par rapport au texte ci-dessous : module `when.ts` (repères) et
`mentions.ts` (au lieu de `past.ts`), types `DayMention` / `DayLink` / `mentionVerdicts` /
`Settings.dayLinks` (au lieu de `PastMention` / `DayAddition` / `pastVerdicts` / `pastMode`),
pas de drapeaux `PAST_ENABLED` / `PAST_ON_TARGET`, pas de préfiltre texte. Synthèse : au lieu de
`sigAll` / `sigSettled`, une synthèse ne reçoit que les notes dites avant le jour où elle est
écrite (même si le jour visé est généré pour une autre raison) : plus de régénération le jour
même, au prix d'une régénération le lendemain dans ce cas ; les répétitions ne comptent pas dans
la signature. Synchro : `DayMention.decidedAt` horodate les gestes, le plus récent l'emporte quand
deux appareils ont changé la même mention.

---

# Recommended design (judge)

« AJOUTÉ PLUS TARD »
Base : conception 3, pour l'interface et l'emplacement dans sync.ts. Greffes :
- de la 2 : grammaire de confiance, ancrage dans la transcription, gel des jours dont une source attend une ré-analyse, déploiement par étapes ;
- de la 1 : prompt minimal, signature calculée sur le contenu des faits, préfiltre texte en option.

PRINCIPE
- On ne réécrit jamais une entrée passée.
- Le fait raconté plus tard est une ANNOTATION de l'entrée source (`analysis.past`). On le regroupe par jour visé au moment de l'affichage : écran Jour, Journal, Markdown, export, entrée de la synthèse.
- La détection passe par l'appel Gemini qui existe déjà : 0 requête de plus par entrée.
- C'est du code déterministe, et non le modèle, qui fixe le jour.
- Le jour visé est mis à jour une seule fois, le lendemain, par la régénération de sa synthèse. Cette régénération dit aussi si le fait était déjà raconté.

1. MODÈLE DE DONNÉES (types.ts est figé : ajouts facultatifs et rétrocompatibles, avec l'accord explicite de l'utilisateur)
  export type PastStatus = 'auto' | 'proposed' | 'confirmed' | 'dismissed';
  export interface PastMention {
    id: string;          // 8 caractères, stable (UI, référence [A1])
    day: DayKey;         // jour visé ; '' tant qu'une proposition n'est pas tranchée
    when: string;        // repère tel que dit, ≤ 60 car.
    text: string;        // fait en 1–2 phrases, 1re personne, ≤ 300 car.
    status: PastStatus;  // confirmed et dismissed = touché par l'utilisateur, conservé à la ré-analyse
    choices?: DayKey[];  // jours possibles d'une proposition (2–3)
    modelDay?: DayKey;   // date du modèle quand elle diffère (diagnostic)
  }
  EntryAnalysis.past?: PastMention[]   // 3 au plus
  DaySynthesis.pastVerdicts?: Record<string /* `${entryId}/${id}` */, 'nouveau' | 'complete' | 'deja'>
  AiClient.synthesizeDay(day, entries, additions?: DayAddition[]) → Pick<…> & { pastVerdicts?: … }
  EntryContext.pastMode?: 'auto' | 'ask' | 'off'
    Ce mode passe par EntryContext parce que services.ts est figé et ne transmet pas les réglages. Le réglage Settings.pastMode? arrive à l'étape B.
- Type dérivé, jamais stocké : DayAddition = { entryId, sourceDay, sourceCreatedAt, mention }.
- Il est produit par collectAdditions(entries) dans le NOUVEAU module pur src/lib/past.ts, qui revalide tout à la lecture : motif et réalité de la date, day < sourceDay, fenêtre, chaînes.
- Seuls les statuts 'auto' et 'confirmed' sont « actifs » sur le jour visé.
- Aucun nouveau fichier Drive, aucun nouveau store IndexedDB. L'entrée JSON grossit d'environ 150 à 400 octets.

2. DÉTECTION (prompts.ts ; aucune requête de plus)
a) Nouvelle puce dans ANALYSIS_RULES (≈ 700 car., ≈ 190 tokens) : « - past : faits que l'auteur situe lui-même sur un jour précis ANTÉRIEUR au jour de l'entrée (« hier », « avant-hier », « il y a trois jours », « lundi », « samedi dernier », « le 3 octobre »). Un élément par jour concerné, 3 au plus : when = le repère de temps recopié tel quel ; date = ce jour (AAAA-MM-JJ) d'après les repères fournis, ou "" si tu hésites ; text = le fait en 1 ou 2 phrases courtes, à la première personne, au passé, compréhensible seul (prénom plutôt que « il »), avec les mots de l'auteur, sans le repère de temps. Exclus : le jour même (ce matin, ce soir, cette nuit), le futur, les habitudes et états durables, les périodes sans jour précis (la semaine dernière, l'autre jour, récemment). Le plus souvent, la liste est vide. »
b) Schéma : past {type:'array', maxItems:3, items:{when:string, date:string, text:string, tous requis, additionalProperties:false}}, ajouté en DERNIÈRE clé de ANALYSIS_PROPERTIES (≈ 330 car., ≈ 110 tokens). La transcription reste la première clé de ENTRY_AUDIO_SCHEMA.
c) formatEntryContext ajoute une ligne de repères (≈ 90 tokens) : « Repères : hier = mercredi 7 octobre (2026-10-07) ; avant-hier = mardi 6 (2026-10-06) ; lundi 5 ; … ; jeudi 1er octobre (2026-10-01). » Elle est construite avec addDays et formatDayFr, sans changer EntryContext. flash-lite n'a alors plus à compter les jours de la semaine.
d) Si pastMode === 'off' : prompt et schéma sans règle, sans repères, sans champ (0 token).
e) Option : pour les entrées TEXTE sans repère temporel détecté par une expression régulière (hier|avant-hier|il y a|lundi…dimanche|dernier|week-end|le \d), envoyer la variante sans `past`. On économise ≈ 400 tokens par entrée texte.

3. RÉSOLUTION DES DATES ET VALIDATION (past.ts, pur, testé par table)
- normalizeAnalysis(raw, ctx?, transcript?) appelle resolvePast(raw.past, ctx, transcript, mode). gemini.ts analyzeAudio et analyzeText lui passent ctx et la transcription ; mock/ai.ts appelle resolvePast sur ses candidats extraits par expressions régulières.
- Référence : R = jour de l'entrée (snap.day) et T = son heure. Jamais l'heure de l'analyse : une entrée analysée en retard se résout toujours bien.
- Normalisation de `when` : minuscules, sans accents, tirets remplacés par des espaces, nombres en lettres convertis en chiffres.
- Ancrage anti-invention (0 token) : la forme repliée de `when` doit figurer dans la transcription repliée, sinon l'élément est rejeté.
- Grammaire, du plus fiable au moins fiable :
  - hier [moment] → R−1, SÛR ; avant-hier → R−2, SÛR.
  - il y a N jours (N de 1 à 31, sauf 8 et 15) → R−N, SÛR.
  - « huit jours » ou « une semaine » → R−7 ; « quinze jours » ou « deux semaines » → R−14 : SÛR si le modèle donne la même date ou rien, sinon proposition {R−7, R−8} (ou {R−14, R−15}).
  - <jour de la semaine> [dernier | passé] → sa dernière occurrence STRICTEMENT avant R (dit un lundi, « lundi » donne R−7) : SÛR si le modèle concorde, sinon proposition [parseur, modèle].
  - <jour> de la semaine dernière → ce jour dans la semaine calendaire précédente, SÛR.
  - le <j> <mois> [année], le j/m, le 1er → la date passée la plus récente, SÛR ; « le <j> » seul → SÛR seulement si le modèle concorde.
  - « le week-end dernier », ou « ce week-end » dit du lundi au vendredi → proposition {samedi, dimanche}.
  - Repère non reconnu mais date du modèle valide → proposition [date du modèle].
  - Vague (la semaine dernière, le mois dernier, l'autre jour, récemment, il y a quelques jours), jour même ou futur → rejet. L'information reste dans l'entrée.
- Nuit (T < 04:00) : « hier » → proposition {R−1, R−2} ; « avant-hier » → {R−2, R−3} ; « il y a N jours » → {R−N, R−N−1}. « ce soir », « cette nuit » et « tout à l'heure » ne sont jamais rétroactifs.
- Bornes : R−31 ≤ jour ≤ R−1. La date doit exister (aller-retour parseDayKey). La date du modèle doit suivre le motif ^\d{4}-\d{2}-\d{2}$ et respecter les mêmes bornes.
- Décision :
  - SÛR → 'auto'.
  - Ambigu ou incertain → 'proposed' avec choices, présélection de la date du modèle si elle fait partie des choix.
  - Désaccord sur une règle SÛRE → le parseur l'emporte et la date du modèle est gardée dans modelDay.
  - pastMode 'ask' → tout passe en 'proposed'.
- Fusion des éléments qui visent le même jour, 3 au plus.
- Constantes MAX_PAST_DAYS = 31, NIGHT_END_HOUR = 4, MAX_PAST = 3, dans past.ts (config.ts est figé).

4. DÉDOUBLONNAGE (aucune requête dédiée ; on ne supprime jamais, on replie)
- L0, dans le prompt : un élément par jour, exclusions, « le plus souvent vide ».
- L1, dans une même entrée : même jour et même foldKey(text) → fusion.
- L2, à la ré-analyse (correction, Réessayer), dans la fonction de rappel de stepAnalyze (sync.ts), avec carryOverPast(prev, next) :
  - on garde les éléments 'confirmed' et 'dismissed' ;
  - on écarte les nouveaux candidats qui leur correspondent (même jour, même `when` replié, ou Jaccard des mots pleins ≥ 0,5) ;
  - les éléments 'auto' et 'proposed' sont remplacés ; leur id est réutilisé si le jour et le texte sont identiques.
  Un ajout retiré ne revient donc jamais.
- L3, entre entrées sources différentes visant le même jour : Jaccard des mots pleins (mots vides retirés) ≥ 0,6. Le plus récent s'affiche replié (« raconté aussi le … ») et n'est envoyé qu'une fois à la synthèse.
- L4, par rapport au contenu du jour visé : verdict rendu par la régénération de sa synthèse (voir 6). Coût : ≈ +150 tokens d'instructions, ≈ +50 tokens d'entrée et ≈ +12 de sortie par ajout. 'deja' → ligne repliée « ↩ Tu y es revenu le jeudi 8 octobre (« il y a deux jours ») » ; 'complete' → étiquette « complète ce jour-là ». Avant le verdict, ou pour un jour sans entrée, l'ajout s'affiche en entier.

5. INTERFACE
Entrée source :
- EntryScreen gagne une section « Ajouté à d'autres jours ». Chaque élément affiche « Mardi 6 octobre · « il y a deux jours » », le texte, un lien « Voir le jour » et un menu : Changer de jour (input date borné à [R−31, R−1]), Modifier le texte, Retirer.
- Un élément retiré reste grisé, avec « Rétablir ».
- Proposition : « À quel jour rattacher ceci ? « le week-end dernier » » [Sam. 3] [Dim. 4] [Autre…] [Ne pas ajouter].
- EntryCard affiche une étiquette « ↪ mar. 6 oct. » ou « 1 jour à confirmer ».
- Toast unique quand une analyse se termine appli ouverte : « Noté aussi au mardi 6 octobre. » Il ne concerne que les entrées analysées pendant la session, pour éviter une rafale au premier pull.
- Le dialogue de suppression précise : « Ses ajouts à d'autres jours (mardi 6 octobre) disparaîtront aussi. »
Jour visé :
- DayScreen affiche le nouveau composant PastAdditions.svelte : une section « Ajouté plus tard » après les entrées, dans l'ordre où les faits ont été dits.
- Chaque carte : surtitre « Dit jeudi 8 oct. à 07:42 · « il y a deux jours » », le fait, « Voir l'entrée › », un menu (Changer de jour, Retirer de ce jour). Le retrait se fait sur place : « Ajout retiré. Rétablir ».
- Pied de SynthesisCard : « 1 ajout sera intégré à la synthèse demain » ou « Inclut 1 ajout raconté plus tard ».
- Les jours qui n'ont que des ajouts apparaissent : filtre de JournalScreen (ligne « Ajouté plus tard : … »), précédent et suivant de DayScreen, état vide adapté. Ils n'ont pas de synthèse.
- helpers.groupDays remplit DayGroup.additions.

6. SYNTHÈSE ET MARKDOWN (sync.ts stepSynthesis, prompts.ts)
Signature :
- base = entriesSignature(analysées), inchangée.
- Sans ajout actif, sigAll = base : octet pour octet identique à l'actuelle, donc 0 régénération au déploiement. Un test doit le garantir.
- Sinon sigAll = `${base}+a${n}-${fnv1a(clés triées)}`, avec clé = `${entryId}:${day}:${fnv1a(foldKey(text))}`. C'est le contenu qui compte, pas updatedAt : une ré-analyse identique ne régénère rien.
- sigSettled = même calcul, mais seulement avec les ajouts dont sourceDay < aujourd'hui.
Règle, si le jour n'est pas forcé :
- existing.basedOn === sigAll → rien à faire ;
- existing.basedOn === sigSettled → reporté au lendemain ;
- une entrée source d'un ajout est isRetryablePending → jour gelé ;
- sinon on génère avec tous les ajouts et basedOn = sigAll.
Effets :
- tous les ajouts d'une journée vers un même jour coûtent 1 requête, au premier lancement du lendemain, avec la synthèse habituelle ;
- un jour qui doit de toute façon être généré prend les ajouts sans surcoût ;
- un ajout retiré ou une source supprimée provoque 1 régénération.
Ordre : demandes forcées, puis jours récents, puis les jours qui ne changent QUE par des ajouts. Plafond maxSynthesesPerRun = 7. Le backoff existant reste valable.
Entrée du modèle :
- buildSynthesisInput(day, entries, additions?) ajoute, seulement s'il y a des ajouts : « Ajouts racontés les jours suivants, dans d'autres entrées : [A1] (dit le jeudi 8 octobre, « il y a deux jours ») … ».
- Règles ajoutées : « intègre-les comme des faits de cette journée sans répéter les entrées ; n'en tire aucune chose à faire ; ajouts[] : statut nouveau | complete | deja ».
- Schéma SYNTHESIS_SCHEMA_WITH_ADDITIONS, utilisé seulement dans ce cas : les requêtes des autres jours restent identiques.
- normalizeSynthesis lit les verdicts (références inconnues ignorées), puis putSynthesis range pastVerdicts.
- parseRemoteSynthesis DOIT recopier pastVerdicts : il reconstruit l'objet champ par champ et les perdrait à chaque pull.
Markdown et export :
- renderDayMarkdown(day, entries, synthesis?, additions?) ajoute « ## Ajouté plus tard » : « - J'ai dîné avec Paul. *(dit le jeudi 8 octobre 2026 à 07:42, « il y a deux jours »)* ». Un doublon devient une ligne de renvoi.
- Le bloc de l'entrée source gagne « ↪ Aussi noté au mardi 6 octobre. »
- stepMirror et buildExportZip prennent l'union des jours (entrées ∪ synthèses ∪ jours visés). Sinon la règle « jour disparu » effacerait les fichiers des jours qui n'ont que des ajouts. fnv1a(md) ne renvoie que les jours modifiés.

7. MODIFICATION ET SUPPRESSION
- Gestes (confirmer, choisir, déplacer, modifier, retirer, rétablir) : app.svelte.ts confirmPast, movePast, editPast, dismissPast, restorePast passent par updateEntry. Ils posent analysis.past[i] et local.dirty = true SANS toucher updatedAt, comme les champs techniques audio, puis lancent runSync.
  - La signature du jour source ne bouge pas : pas de régénération inutile.
  - Celle du jour visé change par le contenu.
- Correction de transcription ou « Réessayer » : la ré-analyse recalcule `past`, et carryOverPast garde les choix de l'utilisateur.
- Supprimer l'entrée source fait disparaître ses ajouts partout et régénère une fois le jour visé s'ils y étaient intégrés.

8. SYNCHRONISATION
- `past` voyage dans entry-<id>.json. parseRemoteEntry recopie déjà `analysis` en entier (sync.ts l.330-332), et collectAdditions revalide à la lecture.
- Les autres appareils récupèrent les gestes, puisque le pull compare modifiedTime.
- À égalité d'updatedAt, la version locale l'emporte (règle actuelle) : c'est acceptable pour un seul utilisateur.
- Une ancienne version de l'appli ignore `past`. Elle pourrait relancer une régénération si deux appareils n'ont pas la même version. Garde-fou dans le nouveau code : pas de régénération automatique si basedOn porte un suffixe inconnu.
- Pas de rattrapage des entrées existantes : il coûterait 1 requête par entrée.

9. DÉPLOIEMENT (chaque étape s'annule seule)
- A : détection, résolution et section sur l'entrée source. Le jour visé n'affiche rien (drapeau PAST_ON_TARGET = false). On note les désaccords dans modelDay pendant quelques jours, et on compare 10 à 15 vrais enregistrements avant et après pour la qualité de la transcription et de l'analyse.
- B : carte sur le jour visé, Journal, Markdown, export, réglage pastMode.
- C : intégration à la synthèse et verdicts de doublon.
- Retour arrière : PAST_ENABLED = false. Les champs restent inertes et facultatifs.

# Implementation plan

PRÉALABLE
- Accord de l'utilisateur sur types.ts : la SPEC demande de signaler le changement, pas de l'appliquer seul.
- Aucun fichier n'a été modifié pendant cette étude.

ÉTAPE A — Détection et entrée source (≈ 500 lignes de code et 450 lignes de tests)
1. src/lib/types.ts : PastStatus, PastMention, EntryAnalysis.past?, EntryContext.pastMode?, DaySynthesis.pastVerdicts?, PastVerdict, paramètre facultatif `additions` et retour `pastVerdicts?` de AiClient.synthesizeDay.
2. NOUVEAU src/lib/past.ts (pur, ≈ 300 lignes) :
   - foldWhen, normalisation des nombres en lettres, isValidDay (copie de celui de helpers) ;
   - parseFrenchWhen(when, R, T) → {confidence, days[]} ;
   - resolvePast(raw, ctx, transcript, mode) avec ancrage, bornes, fusion, statuts ;
   - carryOverPast(prev, next) ; collectAdditions(entries) ; additionKeys et additionsSignature(base, additions, today) → {all, settled} ;
   - wordJaccard ; constantes MAX_PAST_DAYS = 31, NIGHT_END_HOUR = 4, MAX_PAST = 3, PAST_ENABLED, PAST_ON_TARGET.
3. src/lib/prompts.ts : puce `past` dans ANALYSIS_RULES ; PAST_SCHEMA en dernière clé de ANALYSIS_PROPERTIES ; variantes sans `past` (mode off, préfiltre texte facultatif) ; ligne de repères dans formatEntryContext ; normalizeAnalysis(raw, ctx?, transcript?).
4. src/lib/gemini.ts (≈ 15 lignes) : analyzeAudio et analyzeText passent ctx et la transcription à normalizeAnalysis, et choisissent le schéma selon ctx.pastMode.
5. src/lib/mock/ai.ts (≈ 50 lignes) : extraction par expressions régulières (hier, avant-hier, il y a N jours, jours de la semaine), puis resolvePast.
6. src/lib/sync.ts stepAnalyze : ectx.pastMode, et carryOverPast(cur.analysis?.past, result.analysis.past) dans la fonction de rappel de patchEntry.
7. src/lib/app.svelte.ts : confirmPast, choosePastDay, movePast, editPast, dismissPast, restorePast. Ils passent par updateEntry avec dirty = true, sans toucher updatedAt, puis lancent runSync. Ajouter aussi le toast « Noté aussi au… » et le nombre d'ajouts dans le dialogue de suppression.
8. Composants : section « Ajouté à d'autres jours » dans EntryScreen.svelte ; étiquette dans EntryCard.svelte.

ÉTAPE B — Jour visé et copies (≈ 300 lignes)
9. src/components/helpers.ts : DayGroup.additions ; groupDays utilise collectAdditions.
10. NOUVEAU src/components/PastAdditions.svelte, intégré à DayScreen.svelte : section, état vide, pager qui inclut les jours n'ayant que des ajouts.
11. JournalScreen.svelte : le filtre accepte les ajouts ; ligne « 2 entrées · 1 ajout ».
12. src/lib/markdown.ts : renderDayMarkdown(day, entries, synthesis?, additions?), section « Ajouté plus tard » et ligne « ↪ Aussi noté au » sous l'entrée source.
13. sync.ts stepMirror et src/lib/backup.ts : union des jours (entrées ∪ synthèses ∪ jours visés) ; les ajouts sont passés au rendu.
14. Optionnel : Settings.pastMode? dans settings.ts (normalize, merge) et SettingsScreen.svelte (« Ajouts aux jours passés : Automatique / Me demander / Désactivé »).

ÉTAPE C — Synthèse (≈ 200 lignes)
15. prompts.ts : buildSynthesisInput et buildSynthesisRequestText(day, entries, additions?) ; règles d'intégration ; SYNTHESIS_SCHEMA_WITH_ADDITIONS ; normalizeSynthesis lit les verdicts.
16. gemini.ts synthesizeDay(day, entries, additions?) choisit la variante et renvoie pastVerdicts.
17. sync.ts :
   - stepSynthesis : sigAll et sigSettled, report au lendemain, gel si une source est isRetryablePending, ordre (ajouts seuls en dernier), entrée avec ajouts, stockage de pastVerdicts, garde-fou sur un suffixe inconnu ;
   - parseRemoteSynthesis recopie pastVerdicts ;
   - pied de SynthesisCard.svelte (« sera intégré demain » / « inclut 1 ajout »).
18. docs/SPEC.md : §1 (décisions), §2 (signatures modifiées), §3.1 (contenu JSON), §6 (prompts), §8 étapes 1, 4 et 6, §10 (écrans), nouvelle §16 « Ajouté plus tard ».

PLAN DE TEST (Vitest, tests/*.test.ts)
- NOUVEAU past.test.ts (≈ 60 cas en table) :
  - hier et avant-hier, avec moment de la journée ; il y a N jours, en chiffres et en lettres ;
  - huit et quinze jours ; une et deux semaines ;
  - « lundi » dit un lundi (→ R−7) ; « lundi dernier » en accord ou en désaccord avec le modèle ; « de la semaine dernière » ;
  - week-end → proposition ;
  - le 3, le 3 octobre, 3/10, le 1er, le 31 d'un mois de 30 jours (rejet) ;
  - 1er janvier → 30 décembre ; week-ends de changement d'heure (29/03/2026 et 25/10/2026) ; 29 février 2028 ;
  - nuit à 00:40 ; vague, jour même et futur → rejet ; au-delà de 31 jours → rejet ;
  - `when` absent de la transcription → rejet ; mode « ask » ;
  - carryOverPast : un ajout retiré ne revient pas, un ajout déplacé est gardé, ids réutilisés ;
  - collectAdditions : proposés et retirés exclus, données invalides ignorées, regroupement par Jaccard ;
  - additionsSignature identique à entriesSignature sans ajout.
- prompts.test.ts : `past` en dernière clé et requis dans les deux schémas, transcription en premier ; bornes de normalizeAnalysis ; ligne de repères ; entrée et schéma de synthèse avec ajouts seulement si nécessaire ; verdicts inconnus ignorés.
- gemini.test.ts : corps de requête avec ou sans `past` selon pastMode ; requête de synthèse SANS ajout identique octet pour octet à l'actuelle.
- sync.test.ts :
  - (a) déploiement sans ajout → basedOn inchangé, 0 régénération ;
  - (b) mention aujourd'hui vers un jour déjà synthétisé → 0 régénération aujourd'hui, 1 demain ;
  - (c) 3 entrées du jour sur le même jour visé → 1 seule régénération ;
  - (d) jour visé sans synthèse → généré avec les ajouts, rien le lendemain ;
  - (e) retrait d'un ajout intégré → 1 régénération ;
  - (f) source supprimée → régénération sans l'ajout ;
  - (g) source en attente de ré-analyse → jour visé gelé ;
  - (h) geste de l'utilisateur → envoyé (dirty), jour source NON régénéré ;
  - (i) le pull garde `past` et pastVerdicts ;
  - (j) le miroir écrit le fichier d'un jour n'ayant que des ajouts, puis le supprime quand l'ajout est retiré ;
  - (k) correction de transcription → choix de l'utilisateur conservés ;
  - (l) plafond de 7 respecté, ajouts traités en dernier.
- markdown.test.ts : déterminisme, sections, neutralisation. backup.test.ts : union des jours. ui-helpers.test.ts : groupDays, pager. mock.test.ts : extraction de démo. app-controller.test.ts : gestes sans changement d'updatedAt.
- Manuel (étape A, quelques jours) : 10 à 15 vrais enregistrements (hier, avant-hier, lundi dernier, week-end, après minuit, sans mention). Mesurer :
  - le taux de jours exacts, avec les désaccords notés dans modelDay ;
  - les faux positifs ;
  - la qualité de la transcription et de l'analyse avant et après.
  On n'active l'étape B que si les dates sûres sont justes à au moins 95 %.

# Cost table

Hypothèses :
- Entrée vocale de 3 min : environ 7 220 tokens d'entrée (5 760 d'audio + environ 1 460 de texte et schéma : SYSTEM 1 165 car. + prompt audio 2 682 car. + schéma 1 230 car.) et environ 900 tokens de sortie, soit 0,0044 $.
- Ajout du dispositif : environ +390, arrondi à +400 tokens d'entrée (règle d'environ 700 car. + schéma de 330 car. + repères de 266 car., mesurés). Sortie : +5 tokens sans mention, +70 tokens par mention.
- Synthèse (gemini-3.8-flash, réflexion low) : environ 3 300 tokens d'entrée et 1 000 de sortie, soit 0,0062 $ jusqu'au 31/12/2026, puis 0,0125 $.
- Usage : 3 entrées par jour, soit 90 par mois ; une entrée sur 3 contient une mention, soit 30 par mois.
- La probabilité qu'un jour compte au moins une mention vaut 1 − (2/3)³ = 0,70, soit environ 21 jours sources par mois. Cela donne environ 21 régénérations par mois (fourchette 15–25), après report au lendemain et regroupement.

| Cas | Tokens en plus (entrée / sortie) | Requêtes en plus | $ payant 2026 | $ payant 2027 |
|---|---|---|---|---|
| Entrée sans mention | +400 / +5 | 0 | +0,00013 (+3 %) | idem (prix flash-lite inchangé) |
| Entrée avec 1 mention (appel d'entrée) | +400 / +70 | 0 | +0,00030 (+7 %) | idem |
| + part de la régénération du jour visé (≈ 0,7 synthèse par entrée avec mention) | ≈ +2 300 / +700 (moyenne) | ≈ +0,7 sur 3.8-flash | +0,0044 | +0,0087 |
| Une régénération (jour visé) | 3 300 / 1 000 (dont ≈ 250 / 15 pour le bloc d'ajouts et les verdicts) | 1 sur 3.8-flash | 0,0062 | 0,0125 |
| MOIS : détection (90 entrées) | +36 000 / +2 400 | 0 | 0,017 | 0,017 |
| MOIS : régénérations (≈ 21, fourchette 15–25) | ≈ 69 000 / 21 000 | +21 sur 3.8-flash | 0,13 (0,09–0,16) | 0,26 (0,19–0,31) |
| MOIS : total du dispositif | ≈ 105 000 / 23 400 | +21 | ≈ 0,15 | ≈ 0,28 |
| Rappel : base actuelle par mois (90 entrées + 30 synthèses) | | 120 | ≈ 0,58 (0,40 + 0,19) | ≈ 0,77 (0,40 + 0,37) |
| Surcoût relatif | | | ≈ +25 % | ≈ +36 % |
| Variante « affichage seul, sans régénération » | +36 000 / +2 400 | 0 | 0,017 (+3 %) | 0,017 |
| Mode « Désactivé » | 0 | 0 | 0 | 0 |

Offre gratuite (0 $) :
- gemini-3.5-flash-lite : 90 requêtes par mois, comme avant (aucune de plus).
- gemini-3.8-flash : environ 30 requêtes par mois passent à environ 51, soit environ +0,7 par jour. Elles tombent au premier lancement du lendemain : 1 à 3 synthèses à la suite, 7 au plus par cycle. On reste très en dessous de 10 requêtes par minute et d'environ 1 500 par jour. Un 429 passe par le report existant.
- Les tokens par minute ne sont pas concernés : environ +400 par appel.

Pour comparer :
- Sans report au lendemain : environ 30 régénérations par mois au lieu de 21.
- Appel de détection séparé : +90 requêtes flash-lite par mois.
- Résumés des 7 derniers jours envoyés dans chaque analyse : environ +1 300 à 1 500 tokens par entrée, soit environ +120 000 tokens par mois, avec un risque de mélanger les jours.