#!/usr/bin/env node
/**
 * Secret scanning, tuned for this codebase specifically.
 *
 * A generic scanner is easy and useless: it either misses the one credential
 * shape that matters here — an Algorand 25-word mnemonic, which is not a token,
 * has no prefix, and looks exactly like a sentence — or it fires on so many
 * false positives that everyone learns to ignore it. Both failure modes end
 * with a real key going unnoticed.
 *
 * So the rules below are written against what this tree actually contains.
 *
 * ## The mnemonic is the important one
 *
 * `mnemonicToSecretKey(...)` is all over the deploy and register scripts. An
 * Algorand mnemonic is 25 space-separated lowercase words from the BIP-39
 * English wordlist, and unlike every other credential here it carries total
 * control of an account — the deployer's key IS the creator of all three
 * registries. It is also the shape that a plain "looks like base64" or "high
 * entropy" heuristic cannot see at all, because it is neither.
 *
 * Matching on "25 lowercase words" alone would fire on ordinary prose, and this
 * repo is full of long comments. So a candidate is confirmed against the actual
 * BIP-39 wordlist: 25 words that are ALL in the list is not something English
 * produces by accident, and 25 words where several are not is a sentence.
 *
 * ## The trap this had to be built around
 *
 * Compiled TEAL contains labels like:
 *
 *     re_after_inlined_reputation_registry.ReputationRegistry.get_score
 *
 * A naive Resend-key regex — `re_[A-Za-z0-9_]{16,}` — matches that, twelve
 * times, in files that are committed and are supposed to be. A scanner that
 * fires on its own compiler output on day one is a scanner that gets disabled
 * on day two. Real Resend keys are `re_` plus a base64url id, an underscore,
 * and a 24-character secret; `re_after_inlined_…` fails that shape, and there
 * is an explicit exclusion on top of it because relying on a subtle regex
 * difference to protect against a known false positive is how it comes back.
 *
 * ## What it does NOT claim
 *
 * This scans the working tree, not git history. A key that was committed and
 * later removed is still in the history and this will not find it — `git log
 * -p | grep` or a history-rewriting tool is the answer to that, and pretending
 * otherwise would be worse than saying so.
 *
 * Usage: node scan-secrets.mjs [dir]     (default: the repo it sits in)
 * Exit 1 on any finding.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, basename, extname } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(process.argv[2] ?? process.cwd());

// ---------------------------------------------------------------------------
// BIP-39, enough of it to tell a mnemonic from a sentence.
//
// The full list is 2048 words. Carrying all of them in this file would make it
// unreadable, so this is a high-coverage subset plus a structural fallback:
// if MOST words in a 25-word run are in the list, it is treated as a mnemonic.
// A real mnemonic scores 25/25. English prose scores low, because the list is
// deliberately made of uncommon, unambiguous words.
// ---------------------------------------------------------------------------
const BIP39 = new Set(
  ("abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid " +
   "acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice " +
   "aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all " +
   "alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient " +
   "anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple " +
   "approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist " +
   "artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august " +
   "aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag " +
   "balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because " +
   "become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid " +
   "bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur " +
   "blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain " +
   "brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush " +
   "bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz " +
   "cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable " +
   "capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle " +
   "caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter " +
   "charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk " +
   "churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb " +
   "clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect " +
   "color column combine come comfort comic common company concert conduct confirm congress connect consider control convince " +
   "cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle " +
   "craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd " +
   "crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion " +
   "custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide " +
   "decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend " +
   "deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial " +
   "diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish " +
   "dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor " +
   "door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb " +
   "dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit " +
   "educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace " +
   "emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy " +
   "enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt " +
   "escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse " +
   "execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye " +
   "eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father " +
   "fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field " +
   "figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat " +
   "flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest " +
   "forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost " +
   "frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic " +
   "garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe " +
   "girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla " +
   "gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt " +
   "guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk " +
   "hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby " +
   "hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human " +
   "humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness " +
   "image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry " +
   "infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire " +
   "install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous " +
   "jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick " +
   "kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp " +
   "language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg " +
   "legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like " +
   "limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge " +
   "love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man " +
   "manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math " +
   "matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge " +
   "merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery " +
   "miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito " +
   "mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself " +
   "mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net " +
   "network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel " +
   "now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer " +
   "office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit " +
   "orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner " +
   "oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass " +
   "patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper " +
   "perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe " +
   "pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond " +
   "pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare " +
   "present pretty prevent price pride primary print priority prison private prize problem process produce profit program " +
   "project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy " +
   "purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon " +
   "race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason " +
   "rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release " +
   "relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble " +
   "resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge " +
   "rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose " +
   "rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt " +
   "salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors " +
   "scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell " +
   "seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield " +
   "shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight " +
   "sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull " +
   "slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff " +
   "snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source " +
   "south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor " +
   "spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state " +
   "stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong " +
   "struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny " +
   "sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet " +
   "swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste " +
   "tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought " +
   "three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler " +
   "toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total " +
   "tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe " +
   "trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn " +
   "turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold " +
   "unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge " +
   "usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault " +
   "vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village " +
   "vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk " +
   "wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend " +
   "weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink " +
   "winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist " +
   "write wrong yard year yellow you young youth zebra zero zone zoo").split(" ")
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: "algorand-mnemonic",
    title: "Algorand 25-word mnemonic",
    // 25 whitespace-separated lowercase words. Confirmed against BIP-39 below;
    // this pattern alone would match plenty of ordinary sentences.
    pattern: /\b([a-z]{3,8}(?:[ \t\n]+[a-z]{3,8}){24})\b/g,
    confirm: (match) => {
      const words = match.trim().split(/\s+/);
      if (words.length !== 25) return false;
      const known = words.filter((w) => BIP39.has(w)).length;
      // A real mnemonic is 25/25 against the full list; this file carries a
      // subset, so the bar is 20. English prose that clears 20/25 against a
      // list of words like "abandon", "zebra" and "satoshi" does not occur.
      return known >= 20;
    },
    why: "this is a complete Algorand account key. Whoever reads it controls the account, its balance, and every app it created.",
  },
  {
    id: "private-key-block",
    title: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
    why: "a private key in the tree is a private key in every clone of it.",
  },
  {
    id: "algorand-secret-key",
    title: "Algorand 64-byte secret key as base64",
    // An ed25519 secret key is 64 bytes -> 88 base64 chars ending "==".
    pattern: /\b[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g,
    confirm: (match, line) => {
      // Base64 of exactly 64 bytes, in a context that suggests a key rather
      // than a hash or a compiled program.
      if (Buffer.from(match, "base64").length !== 64) return false;

      // An npm lockfile integrity hash is `sha512-` + base64 of a 64-byte
      // digest — identical shape, in every lockfile, thousands of times. This
      // is not a heuristic about likelihood: `"integrity": "sha512-…"` IS a
      // hash, by definition of the field.
      if (/"integrity"|sha512-|sha384-|sha256-|sha1-/.test(line)) return false;

      // No trailing \b on the names: they are nearly always camelCase
      // (`secretKey`, `signerSk`), and `\bsecret\b` does not match inside
      // `secretKey` — that boundary is why this rule silently matched nothing
      // at first. `sk` keeps BOTH boundaries, because `\bsk` alone matched the
      // payload of every `sha512-sK…` hash in a lockfile.
      return /(secret|private|mnemonic|seed|signer|passphrase|\bsk\b)/i.test(line);
    },
    why: "64 base64 bytes next to the word 'key' is an ed25519 secret key.",
  },
  {
    id: "resend-key",
    title: "Resend API key",
    // `re_` + a base64url id + `_` + a 24-char secret. NOT `re_word_word`.
    pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{20,}\b/g,
    confirm: (match) => !match.startsWith("re_after_inlined_"),
    why: "sends mail as this domain.",
  },
  { id: "github-token", title: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, why: "repository access." },
  { id: "aws-access-key", title: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g, why: "AWS account access." },
  { id: "openai-key", title: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g, why: "billed API access." },
  { id: "anthropic-key", title: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, why: "billed API access." },
  { id: "stripe-key", title: "Stripe secret key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, why: "moves money." },
  { id: "slack-token", title: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, why: "posts as this workspace." },
  { id: "google-key", title: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, why: "billed API access." },
  { id: "vercel-token", title: "Vercel token", pattern: /\b(?:vercel_blob_rw_)?[A-Za-z0-9]{24}_[A-Za-z0-9]{28,}\b/g,
    confirm: (_m, line) => /vercel|blob|token/i.test(line), why: "deploys to production." },
  { id: "supabase-service-key", title: "Supabase service_role JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confirm: (match) => {
      try {
        const body = JSON.parse(Buffer.from(match.split(".")[1], "base64url").toString("utf8"));
        // An anon key is public by design; a service_role key bypasses RLS.
        return body.role === "service_role" || body.role === "supabase_admin";
      } catch {
        return false;
      }
    },
    why: "bypasses row-level security — full read/write on every table." },
  {
    id: "assigned-secret",
    title: "A secret-looking value assigned to a secret-sounding name",
    // The catch-all: NAME = "long opaque string". Deliberately last, and
    // deliberately narrow on the name, because this is the rule that produces
    // noise if it is allowed to be clever.
    pattern:
      /\b(?:mnemonic|privateKey|private_key|secretKey|secret_key|apiKey|api_key|accessToken|access_token|password|passwd|client_secret|SECRET|TOKEN)\b\s*[:=]\s*["'`]([^"'`\n]{16,})["'`]/g,
    confirm: (_m, _line, captured) => {
      const v = captured ?? "";
      // Placeholders, env lookups and obvious examples are not secrets.
      if (/^(\$\{|process\.env|import\.meta|<|your[-_ ]|xxx|placeholder|example|changeme|dummy|test|fake|redacted|\.\.\.)/i.test(v)) return false;
      if (/^[A-Z_]+$/.test(v)) return false;
      // A real credential is not a sentence and not a path.
      if (/\s/.test(v) && v.split(/\s+/).length < 20) return false;
      if (v.startsWith("/") || v.startsWith("./") || v.startsWith("http")) return false;
      return true;
    },
    why: "a literal credential in source, whatever it opens.",
  },
];

// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "out", ".venv", "venv", "__pycache__",
  ".turbo", ".vercel", "coverage", ".algokit", ".pytest_cache",
]);
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2",
  ".ttf", ".otf", ".mp4", ".mp3", ".pdf", ".zip", ".gz", ".wasm",
]);
const MAX_BYTES = 3_000_000;

/**
 * Files git ignores are not committed, so a key in one has not left the
 * machine. Scanning them anyway would fire on every developer's real `.env`
 * and make the check useless — the thing worth blocking is a secret that
 * SHIPS. Falls back to scanning everything when git is unavailable, because
 * then nothing is known about what is tracked.
 */
function trackedFilter(root) {
  try {
    const out = execSync("git ls-files -z", { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    const set = new Set(out.toString("utf8").split("\0").filter(Boolean));
    return set.size ? (rel) => set.has(rel) : () => true;
  } catch {
    return () => true;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else if (!SKIP_EXT.has(extname(entry)) && s.size <= MAX_BYTES) yield full;
  }
}

const isTracked = trackedFilter(ROOT);
const findings = [];
let scanned = 0;
let skippedUntracked = 0;

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (!isTracked(rel)) {
    skippedUntracked++;
    continue;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // A NUL byte means binary; a regex over it is meaningless.
  if (text.includes("\0")) continue;
  scanned++;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const value = m[0];
      // The mnemonic pattern spans newlines, so the "line" is where it starts.
      const upto = text.slice(0, m.index);
      const lineNo = upto.split("\n").length;
      const line = text.split("\n")[lineNo - 1] ?? "";
      if (rule.confirm && !rule.confirm(value, line, m[1])) continue;

      findings.push({
        rule: rule.id,
        title: rule.title,
        why: rule.why,
        file: rel,
        line: lineNo,
        // NEVER print the secret. A CI log is a published document, and a
        // scanner that pastes the key into it has moved the key somewhere
        // worse than where it found it.
        preview: `${value.slice(0, 4)}…${value.length} chars`,
      });
    }
  }
}

console.log(`secret scan: ${basename(ROOT)}`);
console.log(`  ${scanned} tracked text file(s) scanned, ${skippedUntracked} untracked/ignored skipped`);
console.log(`  ${RULES.length} rules`);
console.log(
  `  note: this scans the WORKING TREE only. A secret that was committed and later removed is ` +
    `still in git history and this cannot see it.`
);

if (!existsSync(ROOT)) {
  console.error(`::error::${ROOT} does not exist`);
  process.exit(1);
}

if (findings.length === 0) {
  console.log("\nOK — no secrets found.");
  process.exit(0);
}

console.log(`\n${findings.length} finding(s):\n`);
for (const f of findings) {
  console.log(`::error file=${f.file},line=${f.line}::[${f.rule}] ${f.title} — ${f.why}`);
  console.log(`  ${f.file}:${f.line}  ${f.title}  (${f.preview})`);
  console.log(`    ${f.why}`);
}
console.log(
  "\nIf one of these is real: rotate it FIRST, then remove it. Removing it from the tree does not " +
    "remove it from history, and a key that has been pushed is a key that has been published."
);
process.exit(1);
