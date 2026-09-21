/**
 * What the recogniser is allowed to hear.
 *
 * Vosk is given a closed list rather than the whole language: on a court full
 * of other people talking, a recogniser that can only say score words holds up
 * far better than one trying to transcribe everything.
 *
 * It treats the list as a bag of words, though — measured, not assumed:
 * «пятнадцать счёт ноль» comes back verbatim, and every word scores a
 * confidence of 1.0 whether it was spoken or not. So the list buys robustness
 * and nothing else. Structure is the parser's job, and the decoys below are
 * what stop chatter being squeezed into score words for want of anywhere else
 * to go: in the desktop probe they cut false commands from six to one and cost
 * no recall.
 */

/** Spelled with ё. «счет» is not in the model's vocabulary and Vosk drops
 *  unknown words from a grammar without saying so. */
export const WAKE = "счёт";

export const POINT_WORDS = {
  ноль: "0",
  пятнадцать: "15",
  тридцать: "30",
  сорок: "40",
};

/** A tie-break rarely passes 7-5; beyond twelve the touch buttons still work. */
export const COUNT_WORDS = {
  ноль: "0",
  один: "1",
  два: "2",
  три: "3",
  четыре: "4",
  пять: "5",
  шесть: "6",
  семь: "7",
  восемь: "8",
  девять: "9",
  десять: "10",
  одиннадцать: "11",
  двенадцать: "12",
};

const pairs = (words) => words.flatMap((first) => words.map((second) => `${first} ${second}`));

const GAME_PHRASES = [
  ...pairs(Object.keys(POINT_WORDS)),
  "по нулям",
  "по пятнадцати",
  "по тридцати",
  "пятнадцать все",
  "пятнадцать всё",
  "тридцать все",
  "тридцать всё",
  "ровно",
  "больше",
  "меньше",
  "гейм",
  "отмена",
];

const TIE_BREAK_PHRASES = [...pairs(Object.keys(COUNT_WORDS)), "гейм", "отмена"];

const withWake = (phrases) => phrases.map((phrase) => `${WAKE} ${phrase}`);

export const COMMAND_PHRASES = {
  game: withWake(GAME_PHRASES),
  tiebreak: withWake(TIE_BREAK_PHRASES),
};

/** Ordinary words heard around a court. They mean nothing to the parser; they
 *  exist so that chatter has something to be other than a score. */
const DECOYS = `
  я ты он она мы вы они не да нет что как так это этот эта вот там тут здесь уже ещё очень надо можно нужно
  был была было были есть будет давай дай на в с к у за из от до для или и а но же ну ли бы то кто где когда
  почему потому мяч удар корт сетка сетке подача подавай играть играем игра ракетка аут стекло хорошо отлично
  молодец молодцы красиво быстрее подожди сейчас потом сегодня вчера завтра минут человек раз
  один два три четыре пять шесть семь восемь девять десять
  мой твой наш ваш себя меня тебя его её нас вас их мне тебе ему нам вам какой такой точно видел помню знаю
  думаю пожалуйста спасибо ладно конечно просто тоже только если чтобы после перед назад вперёд ближе дальше
  новая лёгкая вода воды
`
  .split(/\s+/)
  .filter(Boolean);

function grammar(phrases) {
  const commandWords = new Set(phrases.flatMap((phrase) => phrase.split(" ")));
  const decoys = DECOYS.filter((word) => !commandWords.has(word));

  return [...phrases, ...decoys, "[unk]"];
}

export const GRAMMARS = {
  game: grammar(COMMAND_PHRASES.game),
  tiebreak: grammar(COMMAND_PHRASES.tiebreak),
};
