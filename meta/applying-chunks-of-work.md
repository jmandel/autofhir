Develop a framework for using multiple external "copilot" cli based agents to apply spec changes in parallel ot the fhir spec, usign workgrees,a nd merging into a "robo-spec-combined" branch/worktree as they make progress. The copilots should indivudally make their own worktrees building on the latest (when thye begin) robot-spec-combined branch, aworkgin indpentnly, and merging into thtat branch/worktree whne done, resolving any merg econflicts. We shoulud have 12 going at a time and the codex coordinator (you) shoud lmonitor, get notifiaiotns when things complete or go wrong, and keep the pipieline running smoothly -- or if anything unexpected is happening, paues and report. Pipeline should ble failr yidempotent so it's easy to notice if a given change has alraeyd been made (e.g. commit messages hsoudl include the issue id from our reports, so an agent can scan hx at startup to make sure it's not doing redunant work).


N.B. you can grep this folder for othre uses of copilot cli to undersatnd good practices for workign with it

Generalyl you shoudl never run longrunning jobs in foreground or do sleeps that you wait on ; you shoudl try to stay availbable for chat here to the max extent possibl ewhile still monitoring with bg notificaoitns.


part of the prompts you give the copilot sshoudl be to read the SKILL.md her ein tehi fhir commutniy search folder and encourage thm to double-check anything ambiguous about hte chanes to be made / investigate anything unclear before makgin ichanges.

and part of the prompt should be commit messag ehygieine: nclude our intternal issue ids, any jiras we're resolving, and if ther eis no existing jira indicated, the commit message hsoudl inlude a "proposed hira" with a title and body explaingin the issue such tthat we can submit for approval 


oh I forgot to say, you'll be farming out changes in "change chunk reports" which can be a flexible mhanisms but in our paritualr ase one file in abstracitons at a time... so each paralell agent call will be given a diferent eabstraitons fil eto read, review, impement ,etc.

and part of hygieine is to also append to a shared journal in an autofihr run folder, journal trackign what issue w fixed and what we skipped for any reason (unclear, unjustified, contradicted by other issues/state etc).

framework shodul be bun.ts; you can add deps as needed.

have ht concpet of a run scoped by "the setotal wset of work we'r etyring to get doe"; in our case the total set is all the changs in the abstracitn sfolder; breaks into chunks which rperenet individual agent reposnsibitlities. But odnt bake into ht eframework thes especific levls, jus idea of a run being a total se tof work and can be restarted/rerun with idempotency within, or a --reset type flag that rolls bac kall progress within the run,a nd chunks tha tapply idmepotenty lbase don agent prompts

› we ant to have a genearl merge shape with squash so history is linear

