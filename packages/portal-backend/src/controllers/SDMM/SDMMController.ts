import * as crypto from 'crypto';

import {CourseController} from "../CourseController";
import {IGitHubController} from "../GitHubController";
import {Grade, Person, Team} from "../../Types";

import Log from "../../../../common/Log";
import Config, {ConfigCourses, ConfigKey} from "../../../../common/Config";
import {GradePayload, Payload, SDMMStatus, StatusPayload} from "../../../../common/types/SDMMTypes";
import Util from "../../../../common/Util";

export class SDMMController extends CourseController {

    public constructor(ghController: IGitHubController) {
        super(ghController);
    }


    /**
     * Performs a complete provisioning task for a given deliverable and set of people.
     *
     * @param {string} delivId
     * @param {string[]} peopleIds people order matters; requestor should be peopleIds[0]
     * @returns {Promise<ResponsePayload>}
     */
    public async provision(delivId: string, peopleIds: string[]): Promise<Payload> {
        Log.info("SDMMController::provision( " + delivId + ", ... ) - start");

        try {
            const name = Config.getInstance().getProp(ConfigKey.name);
            if (name !== ConfigCourses.sdmm && name !== ConfigCourses.classytest) {
                Log.error("SDMMController::provision(..) - SDMMController should not be used for other courses");
                return {failure: {shouldLogout: false, message: "Invalid course; contact course staff."}};
            }

            if (peopleIds.length < 1) {
                Log.error("SDMMController::provision(..) - there needs to be at least one person on a repo");
                return {failure: {shouldLogout: false, message: "Invalid # of people; contact course staff."}};
            }

            if (delivId === "d0") {
                if (peopleIds.length === 1) {
                    Log.info("SDMMController::provision(..) - provisioning new d0 repo for " + peopleIds[0]);
                    return await this.provisionD0Repo(peopleIds[0]);
                } else {
                    Log.error("SDMMController::provision(..) - d0 repos are only for individuals");
                    return {failure: {shouldLogout: false, message: "D0 for indivduals only; contact course staff."}};
                }
            } else if (delivId === "d1") {

                if (peopleIds.length === 1) {
                    Log.info("SDMMController::provision(..) - updating existing d0 repo to d1 for " + peopleIds[0]);
                    return await this.updateIndividualD0toD1(peopleIds[0]);
                } else if (peopleIds.length === 2) {
                    Log.info("SDMMController::provision(..) - provisioning new d1 repo for " + JSON.stringify(peopleIds));
                    if (peopleIds[0] !== peopleIds[1]) {
                        return await this.provisionD1Repo(peopleIds);
                    } else {
                        Log.error("SDMMController::provision(..) - d1 duplicate users");
                        return {
                            failure: {
                                shouldLogout: false,
                                message:      "D1 duplicate users; if you wish to work alone, please select 'work individually'."
                            }
                        };
                    }
                } else {
                    Log.error("SDMMController::provision(..) - d1 can only be performed by single students or pairs of students.");
                    return {failure: {shouldLogout: false, message: "D1 can only be performed by single students or pairs of students."}};
                }
            } else {
                Log.warn("SDMMController::provision(..) - new repo not needed for delivId: " + delivId);
                return {failure: {shouldLogout: false, message: "Repo not needed; contact course staff."}};
            }
        } catch (err) {
            Log.error("SDMMController::provision(..) - ERROR: " + err);
            return {failure: {shouldLogout: false, message: "Unknown error creating repo; contact course staff."}};
        }

    }

    /**
     *
     * This confirms the SDMM status. The approach is conservative (and hence slow).
     *
     * It will try to use checkStatus first to speed itself up.
     * Status chain:
     *
     * D0PRE
     * D0
     * D1UNLOCKED
     * D1TEAMSET
     * D1
     * D2
     * D3PRE
     * D3
     *
     * @param {string} personId
     * @returns {Promise<string>} null if the personId is not even known
     */
    private async computeStatusString(personId: string): Promise<string | null> {
        Log.info("SDMMController::computeStatusString( " + personId + ' ) - start');
        const start = Date.now();

        try {
            const person = await this.dc.getPerson(personId);
            if (person === null) {
                Log.warn("SDMMController::computeStatusString(..) - person null: " + personId);
                throw new Error('Unknown person: ' + personId);
            }

            const reportedStatus = person.custom.sddmStatus;
            // most of the time the status doesn't change, so let's just check that first:
            // const statusCorrect = await this.checkStatus(personId);
            // if (statusCorrect === true) {
            //    Log.info("SDMMController::getStatus(..) - check successful; skipping");
            //    return reportedStatus;
            // }

            let currentStatus = SDMMStatus[SDMMStatus.D0PRE]; // start with the lowest status and work up

            // D0PRE
            if (currentStatus === SDMMStatus[SDMMStatus.D0PRE]) {
                // make sure d0 doesn't exist for a person, if it does, make them D0

                let d0Repo = null;
                let repos = await this.rc.getReposForPerson(person);
                for (const r of repos) {
                    if (r.custom.d0enabled === true) {
                        d0Repo = r;
                    }

                    if (d0Repo !== null) {
                        Log.info("SDMMController::computeStatusString(..) - elevating D0PRE to D0");
                        currentStatus = SDMMStatus[SDMMStatus.D0];
                    } else {
                        Log.info("SDMMController::computeStatusString(..) - NOT elevating from D0PRE");
                    }
                }
            }

            // D0
            if (currentStatus === SDMMStatus[SDMMStatus.D0]) {
                // if their d0 score >= 60, make them D1UNLOCKED
                const d0Grade = await this.dc.getGrade(personId, "d0");
                if (d0Grade && d0Grade.score >= 60) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D0 to D1UNLOCKED");
                    currentStatus = SDMMStatus[SDMMStatus.D1UNLOCKED];
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D0");
                }
            }

            // D1UNLOCKED
            if (currentStatus === SDMMStatus[SDMMStatus.D1UNLOCKED]) {
                // if they have a d1 team, make them D1TEAMSET
                const teams = await this.dc.getTeamsForPerson(personId);

                let d1team: Team = null;
                for (const t of teams) {
                    if (t.custom.sdmmd1 === true) {
                        d1team = t;
                    }
                }

                if (d1team !== null) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D1UNLOCKED to D1TEAMSET");
                    currentStatus = SDMMStatus[SDMMStatus.D1TEAMSET];
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D1UNLOCKED");
                }
            }

            // D1TEAMSET
            if (currentStatus === SDMMStatus[SDMMStatus.D1TEAMSET]) {
                // if they have a d1 repo, make them D1
                const repos = await this.rc.getReposForPerson(person);
                let d1repo = null;
                for (const r of repos) {
                    if (r.custom.d1enabled === true) {
                        d1repo = r;
                    }
                }
                if (d1repo !== null) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D1TEAMSET to D1");
                    currentStatus = SDMMStatus[SDMMStatus.D1];
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D1TEAMSET");
                }
            }

            // D1
            if (currentStatus === SDMMStatus[SDMMStatus.D1]) {
                // if their d1 score > 60, make them D2
                let d1Grade = await this.gc.getGrade(personId, "d1");
                if (d1Grade && d1Grade.score >= 60) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D1 to D2");
                    let allRepos = await this.rc.getReposForPerson(person);
                    for (const r of allRepos) {
                        if (r.custom.d1enabled === true) {
                            // is a project repo
                            r.custom.d2enabled = true;
                            await this.dc.writeRepository(r);
                        }
                    }
                    currentStatus = SDMMStatus[SDMMStatus.D2];
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D1");
                }
            }

            // D2
            if (currentStatus === SDMMStatus[SDMMStatus.D2]) {
                // if their d2 core > 60, make them D3PRE
                let d2Grade = await this.gc.getGrade(personId, "d2");
                if (d2Grade && d2Grade.score >= 60) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D2 to D3PRE");
                    currentStatus = SDMMStatus[SDMMStatus.D3PRE];
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D2");
                }
            }

            // D3PRE
            if (currentStatus === SDMMStatus[SDMMStatus.D3PRE]) {
                // if their d1 repo has custom.sddmD3pr===true, make them D3
                let allRepos = await this.rc.getReposForPerson(person);
                let prComplete = false;
                for (const r of allRepos) {
                    if (r.custom.d2enabled === true && r.custom.sddmD3pr === true) {
                        // is a project repo and has had the pr completed
                        prComplete = true;
                    }
                }
                if (prComplete === true) {
                    Log.info("SDMMController::computeStatusString(..) - elevating D3PRE to D3");
                    currentStatus = SDMMStatus[SDMMStatus.D3];// "D3";
                } else {
                    Log.info("SDMMController::computeStatusString(..) - NOT elevating from D3PRE");
                }
            }

            // D3
            // nothing else to be done
            if (currentStatus === SDMMStatus[SDMMStatus.D3]) {
                let allRepos = await this.rc.getReposForPerson(person);
                for (const r of allRepos) {
                    if (r.custom.d2enabled === true) {
                        // is a project repo
                        r.custom.d3enabled = true;
                        await this.dc.writeRepository(r);
                    }
                }
                Log.info("SDMMController::computeStatusString(..) - NOT elevating from D3");
            }

            // let currentStatus = person.custom.sddmStatus;
            person.custom.sddmStatus = currentStatus;
            this.dc.writePerson(person);

            Log.info("SDMMController::computeStatusString( " + personId + ' ) - done; took: ' + Util.took(start));
            return currentStatus;
        } catch (err) {
            Log.error("SDMMController::computeStatusString( " + personId + ' ) - ERROR: ' + err);
            throw new Error("Error computing status for " + personId + "; contact course staff.");
        }
    }

    /**
     *
     * This confirms the custom.sddmStatus is correct.
     *
     * It will try to use checkStatus first to speed itself up.
     * Status chain:
     *
     * D0PRE
     * D0
     * D1UNLOCKED
     * D1TEAMSET
     * D1
     * D2
     * D3PRE
     * D3
     *
     * @param {string} personId
     * @returns {Promise<string>}
     */

    /*
    private async checkStatus(personId: string): Promise<boolean> {
        Log.info("SDMMController::getStatus( " + personId + ' ) - start');
        const start = Date.now();
        try {
            const person = await this.dc.getPerson(personId);
            if (person === null) {
                Log.info("SDMMController::checkStatus(..) - ERROR; person null");
                return null;
            }

            const reportedStatus = person.custom.sddmStatus;
            if (reportedStatus === SDMMStatus[SDMMStatus.D0PRE]) {
                // don't bother, let checkStatus do it right
                return false;
            }

            // TODO: actually do this if it looks like getStatus is proving to be too slow

            return false;

        } catch (err) {
            Log.info("SDMMController::checkStatus(..) - ERROR: " + err);
        }
    }
*/

    private async provisionD0Repo(personId: string): Promise<Payload> {
        Log.info("SDMMController::provisionD0Repo( " + personId + " ) - start");
        const start = Date.now();

        try {
            const name = personId;
            const person = await this.pc.getPerson(name);
            const teamName = name;
            const repoName = CourseController.getProjectPrefix() + teamName;

            if (person === null) {
                // return early
                return {failure: {shouldLogout: false, message: "Username not registered; contact course staff."}};
            }

            let personStatus = await this.computeStatusString(personId);
            if (personStatus !== SDMMStatus[SDMMStatus.D0PRE]) {
                Log.info("SDMMController::provisionD0Repo( " + personId + " ) - bad status: " + personStatus);
                return {failure: {shouldLogout: false, message: "User is not eligible for D0."}};
            } else {
                Log.info("SDMMController::provisionD0Repo( " + personId + " ) - correct status: " + personStatus);
            }

            // create local team
            let existingTeam = await this.tc.getTeam(teamName);
            if (existingTeam !== null) {
                // team already exists; warn and fail
                throw new Error("SDMMController::provisionD0Repo(..) - team already exists: " + teamName);
            }
            const teamCustom = {sdmmd0: true, sdmmd1: false, sdmmd2: false, sdmmd3: false}; // d0 team for now
            const team = await this.tc.createTeam(teamName, [person], teamCustom);

            // create local repo
            let existingRepo = await this.rc.getRepository(repoName);
            if (existingRepo !== null) {
                // repo already exists; warn and fail
                throw new Error("SDMMController::provisionD0Repo(..) - repo already exists: " + repoName);
            }
            const repoCustom = {d0enabled: true, d1enabled: false, d2enabled: false, d3enabled: false, sddmD3pr: false}; // d0 repo for now
            const repo = await this.rc.createRepository(repoName, [team], repoCustom);

            // create remote repo
            const INPUTREPO = "https://github.com/SECapstone/bootstrap"; // HARDCODED for SDMM D0
            // set to the backendUrl:backendPort, not autotestUrl:autotestPort since the backend will be publicly visible
            const WEBHOOKADDR = Config.getInstance().getProp(ConfigKey.backendUrl) + ':' + Config.getInstance().getProp(ConfigKey.backendPort) + '/githubWebhook';
            const provisionResult = await this.gh.provisionRepository(repoName, [team], INPUTREPO, WEBHOOKADDR);

            if (provisionResult === true) {
                Log.info("SDMMController::provisionD0Repo(..) - d0 github provisioning successful");

                // update local team and repo with github values
                const repoUrl = await this.gh.getRepositoryUrl(repo);
                repo.URL = repoUrl;
                this.dc.writeRepository(repo);

                const teamUrl = await this.gh.getTeamUrl(team);
                team.URL = teamUrl;
                this.dc.writeTeam(team);

                // create grade entry
                let grade: GradePayload = {
                    score:     -1,
                    comment:   'Repo Provisioned',
                    urlName:   repo.id,
                    URL:       repo.URL,
                    timestamp: Date.now(),
                    custom:    {}
                };
                await this.gc.createGrade(repo.id, 'd0', grade);

                const statusPayload = await this.getStatus(personId);
                Log.info("SDMMController::provisionD0Repo(..) - d0 final provisioning successful; took: " + Util.took(start));

                return {success: {message: "Repository successfully created.", status: statusPayload}};
            } else {
                Log.error("SDMMController::provisionD0Repo(..) - something went wrong provisioning this repo; see logs above.");

                // d0pre people should not have teams
                const delTeam = await this.dc.deleteTeam(team);
                // d0pre people should not have repos
                const delRepo = await this.dc.deleteRepository(repo);
                Log.info("SDMMController::provisionD0Repo(..) - team removed: " + delTeam + ", repo removed: " + delRepo);

                return {failure: {shouldLogout: false, message: "Error provisioning d0 repo."}};
            }
        } catch (err) {
            Log.error("SDMMController::provisionD0Repo(..) - ERROR: " + err);
            return {failure: {shouldLogout: false, message: "Error creating d0 repo; contact course staff."}};
        }
    }

    private async updateIndividualD0toD1(personId: string): Promise<Payload> {
        Log.info("SDMMController::updateIndividualD0toD1( " + personId + " ) - start");
        const start = Date.now();

        try {
            // make sure person exists
            const person = await this.pc.getPerson(personId);
            if (person === null) {
                Log.error("SDMMController::updateIndividualD0toD1(..) - person does not exist: " + personId);
                return {failure: {shouldLogout: false, message: "Username not registered with course."}};
            }

            // make sure the person has suffient d0 grade
            let grade = await this.gc.getGrade(personId, "d0"); // make sure they can move on
            if (grade === null || grade.score < 60) {
                Log.error("SDMMController::updateIndividualD0toD1(..) - person does not exist: " + personId);
                return {failure: {shouldLogout: false, message: "Current d0 grade is not sufficient to move on to d1."}};
            }

            // make sure the person does not already have a d1 repo
            let myRepos = await this.rc.getReposForPerson(person);
            for (const r of myRepos) {
                if (r.custom.d1enabled === true) {
                    Log.error("SDMMController::updateIndividualD0toD1(..) - person already has a d1 repo: " + r.id);
                    return {failure: {shouldLogout: false, message: "D1 repo has already been assigned: " + r.id}};
                }
            }

            let personStatus = await this.computeStatusString(personId);
            if (personStatus !== SDMMStatus[SDMMStatus.D1UNLOCKED]) {
                Log.info("SDMMController::updateIndividualD0toD1( " + personId + " ) - bad status: " + personStatus);
            } else {
                Log.info("SDMMController::updateIndividualD0toD1( " + personId + " ) - correct status: " + personStatus);
            }

            const name = personId;
            // const person = await this.pc.getPerson(name);
            const teamName = name;
            const repoName = CourseController.getProjectPrefix() + teamName;

            // find local team & repo
            const team = await this.tc.getTeam(teamName);
            const repo = await this.rc.getRepository(repoName);

            if (team !== null && repo !== null) {
                // custom should be {d0enabled: true, d1enabled: true, d2enabled: false, d3enabled: false, sddmD3pr: false};
                repo.custom.d1enabled = true;
                await this.dc.writeRepository(repo);

                // team custom should be {sdmmd0: true, sdmmd1: true, sdmmd2: true, sdmmd3: true};
                team.custom.sdmmd1 = true;
                team.custom.sdmmd2 = true;
                team.custom.sdmmd3 = true;
                await this.dc.writeTeam(team);

                // create grade entries
                let grade: GradePayload = {
                    score:     -1,
                    comment:   'Repo Provisioned',
                    urlName:   repo.id,
                    URL:       repo.URL,
                    timestamp: Date.now(),
                    custom:    {}
                };
                await this.gc.createGrade(repo.id, 'd1', grade);
                await this.gc.createGrade(repo.id, 'd2', grade);
                await this.gc.createGrade(repo.id, 'd3', grade);
            } else {
                Log.error("SDMMController::updateIndividualD0toD1(..) - unable to find team: " + teamName + ' or repo: ' + repoName);
                return {failure: {shouldLogout: false, message: "Invalid team updating d0 repo; contact course staff."}};
            }

            const statusPayload = await this.getStatus(personId);
            Log.info("SDMMController::updateIndividualD0toD1(..) - d0 to d1 individual upgrade successful; took: " + Util.took(start));
            return {success: {message: "D0 repo successfully updated to D1.", status: statusPayload}};
        } catch (err) {
            Log.error("SDMMController::updateIndividualD0toD1(..) - ERROR: " + err);
            return {failure: {shouldLogout: false, message: "Error updating d0 repo; contact course staff."}};
        }
    }

    /**
     * @param {string[]} peopleIds order matters here: the requestor should be peopleIds[0]
     * @returns {Promise<Payload>}
     */
    private async provisionD1Repo(peopleIds: string[]): Promise<Payload> {
        Log.info("SDMMController::provisionD1Repo( " + JSON.stringify(peopleIds) + " ) - start");
        const start = Date.now();

        try {
            // seems complicated, but we need team names that are unique
            // but with lots of people signing up at once we can't rely on a counter
            // especially since full provisioning will take a long time (e.g., 60+ seconds)
            let teamName: string | null = null;
            while (teamName === null) {
                let str = crypto.randomBytes(256).toString('hex');
                str = str.substr(0, 6);
                const name = CourseController.getTeamPrefix() + str; // team prefix
                Log.trace("SDMMController::provisionD1Repo(..) - checking name: " + str);
                let team = await this.tc.getTeam(str);
                if (team === null) {
                    teamName = str;
                    Log.trace("SDMMController::provisionD1Repo(..) - name available; using: " + teamName);
                }
            }

            let people: Person[] = [];
            for (const pid of peopleIds) {
                let person = await this.dc.getPerson(pid); // make sure the person exists
                if (person !== null) {
                    let grade = await this.gc.getGrade(pid, "d0"); // make sure they can move on
                    if (grade !== null && grade.score > 59) {
                        people.push(person)
                    } else {
                        return {
                            failure: {
                                shouldLogout: false,
                                message:      "All teammates must have achieved a score of 60% or more to join a team."
                            }
                        };
                    }
                } else {
                    return {
                        failure: {
                            shouldLogout: false,
                            message:      "Unknown person " + pid + " requested to be on team; please make sure they are registered with the course."
                        }
                    };
                }
            }

            for (const p of people) {
                let personStatus = await this.computeStatusString(p.id);
                if (personStatus !== SDMMStatus[SDMMStatus.D1UNLOCKED]) {
                    Log.info("SDMMController::provisionD1Repo( " + p.id + " ) - bad status: " + personStatus);
                    return {
                        failure: {
                            shouldLogout: false,
                            message:      "All teammates must be eligible to join a team and must not already be performing d1 in another team or on their own."
                        }
                    };
                } else {
                    Log.info("SDMMController::provisionD1Repo( " + p.id + " ) - correct status: " + personStatus);
                }
            }

            // create local team
            const teamCustom = {sdmmd0: false, sdmmd1: true, sdmmd2: true, sdmmd3: true}; // configure for project
            const team = await this.tc.createTeam(teamName, people, teamCustom);

            // create local repo
            const repoName = CourseController.getProjectPrefix() + teamName;
            const repoCustom = {d0enabled: false, d1enabled: true, d2enabled: true, d3enabled: true, sddmD3pr: false}; // d0 repo for now
            const repo = await this.rc.createRepository(repoName, [team], repoCustom);

            // create remote repo
            const INPUTREPO = "https://github.com/SECapstone/bootstrap"; // HARDCODED for SDMM
            // set to the backendUrl:backendPort, not autotestUrl:autotestPort since the backend will be publicly visible
            const WEBHOOKADDR = Config.getInstance().getProp(ConfigKey.backendUrl) + ':' + Config.getInstance().getProp(ConfigKey.backendPort) + '/githubWebhook';
            const provisionResult = await this.gh.provisionRepository(repoName, [team], INPUTREPO, WEBHOOKADDR);

            if (provisionResult === true) {
                Log.info("SDMMController::provisionD1Repo(..) - d1 github provisioning successful");

                // update local team and repo with github values
                const repoUrl = await this.gh.getRepositoryUrl(repo);
                repo.URL = repoUrl;
                this.dc.writeRepository(repo);

                const teamUrl = await this.gh.getTeamUrl(team);
                team.URL = teamUrl;
                this.dc.writeTeam(team);

                // create grade entries
                let grade: GradePayload = {
                    score:     -1,
                    comment:   'Repo Provisioned',
                    urlName:   repo.id,
                    URL:       repo.URL,
                    timestamp: Date.now(),
                    custom:    {}
                };
                await this.gc.createGrade(repo.id, 'd1', grade);
                await this.gc.createGrade(repo.id, 'd2', grade);
                await this.gc.createGrade(repo.id, 'd3', grade);

                const statusPayload = await this.getStatus(peopleIds[0]);
                Log.info("SDMMController::provisionD1Repo(..) - d1 final provisioning successful; took: " + Util.took(start));
                return {success: {message: "D1 repository successfully provisioned.", status: statusPayload}};
            } else {
                Log.error("SDMMController::provisionD1Repo(..) - something went wrong provisioning this repo; see logs above.");
                return {failure: {shouldLogout: false, message: "Error encountered creating d1 repo; contact course staff."}};
            }
        } catch (err) {
            Log.error("SDMMController::provisionD1Repo(..) - ERROR: " + err);
            return {failure: {shouldLogout: false, message: "Error encountered provisioning d1 repo; contact course staff."}};
        }
    }

    public async getStatus(personId: string): Promise<StatusPayload> {
        Log.info("SDMMController::getStatus( " + personId + " ) - start");
        const start = Date.now();

        const myStatus = await this.computeStatusString(personId);

        let myD0: GradePayload = null;
        let myD1: GradePayload = null;
        let myD2: GradePayload = null;
        let myD3: GradePayload = null;

        let d0Grade: Grade = await this.dc.getGrade(personId, 'd0');
        let d1Grade: Grade = await this.dc.getGrade(personId, 'd1');
        let d2Grade: Grade = await this.dc.getGrade(personId, 'd2');
        let d3Grade: Grade = await this.dc.getGrade(personId, 'd3');

        if (d0Grade !== null) {
            myD0 = {
                score:     d0Grade.score,
                urlName:   d0Grade.urlName,
                URL:       d0Grade.URL,
                comment:   '',
                timestamp: d0Grade.timestamp,
                custom:    {}
            }
        }

        if (d1Grade !== null) {
            myD1 = {
                score:     d1Grade.score,
                urlName:   d1Grade.urlName,
                URL:       d1Grade.URL,
                comment:   '',
                timestamp: d1Grade.timestamp,
                custom:    {}
            }
        }

        if (d2Grade !== null) {
            myD2 = {
                score:     d2Grade.score,
                urlName:   d2Grade.urlName,
                URL:       d2Grade.URL,
                comment:   '',
                timestamp: d2Grade.timestamp,
                custom:    {}
            }
        }

        if (d3Grade !== null) {
            myD3 = {
                score:     d3Grade.score,
                urlName:   d3Grade.urlName,
                URL:       d3Grade.URL,
                comment:   '',
                timestamp: d3Grade.timestamp,
                custom:    {}
            }
        }

        let statusPayload = {
            status: myStatus,
            d0:     myD0,
            d1:     myD1,
            d2:     myD2,
            d3:     myD3
        };

        Log.trace("SDMMController::getStatus( " + personId + " ) - took: " + Util.took(start));

        return statusPayload;
    }

    public async handleUnknownUser(githubUsername: string): Promise<Person | null> {
        const name = Config.getInstance().getProp(ConfigKey.name);
        Log.info("SDDMController::handleUnknownUser( " + githubUsername + " ) - start");
        if (name === ConfigCourses.sdmm || name === ConfigCourses.classytest) {
            Log.info("SDDMController::handleUnknownUser(..) - new person for this course; - provisioning");

            // in the secapstone we don't know who the students are in advance
            // in this case, we will create Person objects on demand

            // make person
            let newPerson: Person = {
                id:            githubUsername,
                csId:          githubUsername, // sdmm doesn't have these
                githubId:      githubUsername,
                studentNumber: null,

                fName:  '',
                lName:  '',
                kind:   'student',
                URL:    'https://github.com/' + githubUsername, // HARDCODE
                labId:  'UNKNOWN',
                custom: {}
            };

            newPerson.custom.sdmmStatus = 'd0pre'; // new users always start in d0pre state

            // add to database
            await this.dc.writePerson(newPerson);
            return newPerson;
        }

        Log.error("SDDMController::handleUnknownUser() - not a SDDM course");
        return null;
    }

}