# How to read the code graph (GR-18)

*CC, 2026-11-01. For the evaluating agent (EN-13). This guide, the index and the skeleton below are the procedure: the
agent's prompt holds a role and principles only.*

## Read in this order
1. **The index** (`model.index(graph)`), one block per layer: state law (OR, order 0), then the city (PDX, order 1).
   Each entry gives a provision's id, type, title, section, topics, parameter names and its gray-area count. It holds
   no text. Pick the provisions the question touches from it.
2. **The family** of each rule you will apply (`model.family(graph, rule_id)`): the rule, its exceptions
   (recursively), the preemptions that can override it, every definition it reaches, and every gray area on any of
   them. A rule's family is everything that can change how it applies.
3. **The text**, only for the provisions you apply, and as of the question's date: the version in force on that date
   (`status_on`), never a later one.
4. **The operator** for each rule (`curated/operators.json`): the tool to call, the facts it reads and the parameters
   it takes from the text. Every number comes from a tool (EN-14).

## Rules of reading
- **Unknown is not no.** A fact that isn't in the input makes a condition unknown; an exception whose condition is
  unknown gives NEEDS_CHECK, with both outcomes shown (EN-17).
- **A gray area changes the answer only when it changes the outcome** (GR-30). Check it if its `matters_when` holds,
  or may hold. If its readings give the same verdict, report it and keep the verdict. If they differ, the answer is
  FITS_IF, naming the reading that fits, its clause, and who settles it.
- **Conflicting observations** of one fact are evaluated each way. The same verdict is kept and the conflict is
  reported; a different verdict gives NEEDS_CHECK.
- **Confirmation.** Unconfirmed or stale items (`model.confirmation_status`) are named in the answer wherever they
  decide it.
- **Clauses not modeled.** A not-modeled clause in a provision you apply (the clause ledger, GR-32) is read and reported.
  It is never skipped silently.
- **Physical fit always holds.** A placement must sit inside the lot and clear of the house and every existing
  structure (GR-29). Use the lot frame and the placement convention in `curated/conventions.json` (GR-31).

## The evaluation skeleton
1. **Date and layers.** Fix the as-of date, then select the jurisdiction's layers in order.
2. **Gates first.** Can an ADU be here at all? Check the zone, the housing type allowed, the overlays that remove the
   option, and the trees and historic triggers. If a gate fails, the verdict is BLOCKED_BY_GATE, and nothing else
   runs (EN-16).
3. **Plan constraints next.** Limits no placement can cure: the ADU's living area, its height, its footprint
   dimensions. If one fails, the verdict is NO_LEGS for this plan, with the limit stated; no placement is searched
   (in propose mode the search continues for a plan that meets the limit) (EN-16).
4. **Placement constraints.** For each rule that shapes where the ADU can go (setbacks, front or behind the house,
   coverage), take its family, apply the exceptions whose conditions all hold, and call the operator's tool, for the
   client's spot and for the selected placement.
5. **Placement.** Use the client's spot if one is given, and check it against everything (EN-19). Otherwise search
   with `find_placements`.
6. **Doubts.** Resolve gray areas and conflicts as above.
7. **Verdict:**
   - **FITS:** a placement passes every rule.
   - **FITS_IF:** a placement passes under a stated condition (a reading, a fact to confirm), with the clause and who
     can settle it.
   - **NO_LEGS:** no placement passes, or a plan constraint fails (for this plan, with the limit).
   - **BLOCKED_BY_GATE:** a gate fails.
   - **NEEDS_CHECK:** an unknown or a conflict decides it (the answer names the fact).
   - **NOT_MODELED:** the question is outside what the graph covers on that date.
