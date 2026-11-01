/**
 * Words a model uses to say it does not have the answer. The prompt asks it to say it does not know
 * when the sources do not contain the answer, but not in fixed words, so this is a heuristic. The
 * evaluation uses the same one, so what is measured in production and in the gate agree.
 */
const ABSTENTION =
  /could not find|couldnt find|do not know|dont know|cannot provide|cant provide|no information|not able to (?:find|answer)/i;

/** Did the assistant decline to answer (nothing found, not known)? */
export const isAbstention = (answer: string): boolean =>
  ABSTENTION.test(answer.replace(/['’]/g, ''));
