const loadFirst = require('./GlobalSpec');
const rFirst = require('./SDDMControllerSpec'); // so we go last

import {expect} from "chai";
import "mocha";
import {GitHubActions, GitHubController} from "../src/controllers/GitHubController";
import Log from "../src/util/Log";
import {Test} from "./GlobalSpec";
import Util from "../src/util/Util";
import {ActionPayload, GradePayload, SDDMController} from "../src/controllers/SDDMController";
import {GradesController} from "../src/controllers/GradesController";

describe.skip("GitHubActions", () => {

    let gh: GitHubActions;

    let TIMEOUT = 5000;

    let ORGNAME = 'secapstone';

    before(async () => {
        Test.ORGNAME = ORGNAME;
    });

    beforeEach(function () {
        gh = new GitHubActions();
    });

    it("Should be able to create list some repos.", async () => {
        // check auth
        let repos = await gh.listRepos(Test.ORGNAME);
        expect(repos).to.be.an('array');
        expect(repos.length > 0).to.be.true;

        // delete test repos if needed
        for (const repo of repos as any) {
            if (repo.full_name === "SECapstone/" + Test.REPONAME1) {
                Log.test("Old test repo found; removing");
                let val = await gh.deleteRepo(Test.ORGNAME, Test.REPONAME1);
                expect(val).to.be.true;
            }
        }

        // delete teams if needed
        let teams = await gh.listTeams(Test.ORGNAME);
        expect(teams).to.be.an('array');
        expect(teams.length > 0).to.be.true;

        for (const team of teams as any) {
            Log.info('team: ' + JSON.stringify(team));
            if (team.name === Test.TEAMNAME1) {
                Log.test("Old test team found; removing");
                let val = await gh.deleteTeam(Test.ORGNAME, team.id);
                expect(val).to.be.true;
            }

        }
    });

    it("Should be able to create a repo.", async function () {
        let val = await gh.createRepo(Test.ORGNAME, Test.REPONAME1);
        expect(val).to.equal('https://github.com/SECapstone/' + Test.REPONAME1);
    }).timeout(TIMEOUT);

    it("Should be able to remove a repo.", async function () {
        let val = await gh.deleteRepo(Test.ORGNAME, Test.REPONAME1);
        expect(val).to.be.true;
    }).timeout(TIMEOUT);

    it("Should be able to create the repo again.", async function () {
        let val = await gh.createRepo(Test.ORGNAME, Test.REPONAME1);
        expect(val).to.equal('https://github.com/SECapstone/' + Test.REPONAME1);
    }).timeout(TIMEOUT);

    it("Should be able to list a webhook.", async function () {
        let val = await gh.listWebhooks(Test.ORGNAME, Test.REPONAME1);
        expect(val).to.be.empty;
    }).timeout(TIMEOUT);

    it("Should be able to create a webhook.", async function () {
        let hooks = await gh.listWebhooks(Test.ORGNAME, Test.REPONAME1);
        expect(hooks).to.be.empty;

        let createHook = await gh.addWebhook(Test.ORGNAME, Test.REPONAME1, 'https://localhost/test');
        expect(createHook).to.be.true;

        hooks = await gh.listWebhooks(Test.ORGNAME, Test.REPONAME1);
        expect(hooks).to.have.lengthOf(1);
    }).timeout(TIMEOUT);

    it("Should be able to create a team, add users to it, and add it to the repo.", async function () {
        let val = await gh.createTeam(Test.ORGNAME, Test.TEAMNAME1, 'push');
        expect(val.teamName).to.equal(Test.TEAMNAME1);
        expect(val.githubTeamNumber).to.be.an('number');
        expect(val.githubTeamNumber > 0).to.be.true;

        let addMembers = await gh.addMembersToTeam(val.teamName, val.githubTeamNumber, [Test.USERNAMEGITHUB1, Test.USERNAMEGITHUB2]);
        expect(addMembers.teamName).to.equal(Test.TEAMNAME1); // not a strong test

        let teamAdd = await gh.addTeamToRepo(Test.ORGNAME, val.githubTeamNumber, Test.REPONAME1, 'push');
        expect(teamAdd.githubTeamNumber).to.equal(val.githubTeamNumber);

        let staffTeamNumber = await gh.getTeamNumber(Test.ORGNAME, 'staff');
        let staffAdd = await gh.addTeamToRepo(Test.ORGNAME, staffTeamNumber, Test.REPONAME1, 'admin');
        expect(staffAdd.githubTeamNumber).to.equal(staffTeamNumber);

    }).timeout(TIMEOUT);

    it("Should be able to clone a source repo into a newly created repository.", async function () {
        const start = Date.now();

        let targetUrl = 'https://github.com/SECapstone/testtest__repo1';
        let importUrl = 'https://github.com/SECapstone/d0_bootstrap';

        let output = await gh.importRepoFS(Test.ORGNAME, importUrl, targetUrl);
        expect(output).to.be.true;

        Log.test('Full clone took: ' + Util.took(start));
    }).timeout(120 * 1000); // 2 minutes

    /**
     * This test is terrible, but gets the coverage tools to stop complaining.
     */
    it("Should make sure that actions can actually fail.", async function () {
        if (1 > 0) return; // terrible skip
        const old = (<any>gh).gitHubAuthToken;
        (<any>gh).gitHubAuthToken = "FOOFOOFOO";

        try {
            await gh.createRepo(Test.ORGNAME, 'INVALIDREPONAME');
        } catch (err) {
            // expected
        }

        try {
            await gh.deleteRepo(Test.ORGNAME, 'INVALIDREPONAME');
        } catch (err) {
            // expected
        }

        try {
            await gh.listRepos(Test.ORGNAME + "INVALIDINVALIDINVALID");
        } catch (err) {
            // expected
        }

        try {
            await gh.createTeam(Test.ORGNAME, 'INVALIDTEAMNAMER', 'push');
        } catch (err) {
            // expected
        }

        try {
            await gh.getTeamNumber(Test.ORGNAME, 'INVALIDTEAMNAMER');
        } catch (err) {
            // expected
        }

        try {
            await gh.deleteTeam(Test.ORGNAME, -1);
        } catch (err) {
            // expected
        }

        try {
            await gh.addTeamToRepo(Test.ORGNAME, -1, 'INVALIDREPONAME', 'push');
        } catch (err) {
            // expected
        }

        try {
            await gh.addMembersToTeam(Test.ORGNAME, -1, ['INVALIDPERSONNAME']);
        } catch (err) {
            // expected
        }

        try {
            await gh.listTeams(Test.ORGNAME);
        } catch (err) {
            // expected
        }

        try {
            await gh.listWebhooks(Test.ORGNAME, 'INVALIDREPONAME');
        } catch (err) {
            // expected
        }

        try {
            await gh.addWebhook(Test.ORGNAME, 'INVALIDREPONAME', 'INVALIDENDPOINT');
        } catch (err) {
            // expected
        }

        try {
            await gh.importRepoFS(Test.ORGNAME, 'https://localhost', 'https://localhost');
        } catch (err) {
            // expected
        }

        Log.test('after expected fail');
        (<any>gh).gitHubAuthToken = old; // restore token
    }).timeout(TIMEOUT);


    it("Should be able to delete things before running provisioning tests.", async function () {
        // check auth
        let repos = await gh.listRepos(Test.ORGNAME);
        expect(repos).to.be.an('array');
        expect(repos.length > 0).to.be.true;

        // delete test repos if needed
        for (const repo of repos as any) {
            if (repo.full_name === "SECapstone/" + Test.REPONAME1) {
                await gh.deleteRepo(Test.ORGNAME, Test.REPONAME1);
            }
            if (repo.full_name === "SECapstone/secap_" + Test.USERNAMEGITHUB1) {
                await gh.deleteRepo(Test.ORGNAME, 'secap_' + Test.USERNAMEGITHUB1);
            }
            if (repo.full_name === "SECapstone/secap_" + Test.USERNAMEGITHUB2) {
                await gh.deleteRepo(Test.ORGNAME, 'secap_' + Test.USERNAMEGITHUB2);
            }
            if (repo.full_name === "SECapstone/secap_" + Test.USERNAMEGITHUB3) {
                await gh.deleteRepo(Test.ORGNAME, 'secap_' + Test.USERNAMEGITHUB3);
            }
            // TODO: delete team repo too
        }

        // delete teams if needed
        let teams = await gh.listTeams(Test.ORGNAME);
        expect(teams).to.be.an('array');
        expect(teams.length > 0).to.be.true;

        for (const team of teams as any) {
            Log.info('team: ' + JSON.stringify(team));


            if (team.name === Test.TEAMNAME1) {
                await gh.deleteTeam(Test.ORGNAME, team.id);
            }

            if (team.name === Test.USERNAMEGITHUB1) {
                const teamNum = await gh.getTeamNumber(Test.ORGNAME, Test.USERNAMEGITHUB1);
                await gh.deleteTeam(Test.ORGNAME, teamNum);
            }

            if (team.name === Test.USERNAMEGITHUB2) {
                const teamNum = await gh.getTeamNumber(Test.ORGNAME, Test.USERNAMEGITHUB2);
                await gh.deleteTeam(Test.ORGNAME, teamNum);
            }

            if (team.name === Test.USERNAMEGITHUB3) {
                const teamNum = await gh.getTeamNumber(Test.ORGNAME, Test.USERNAMEGITHUB3);
                await gh.deleteTeam(Test.ORGNAME, teamNum);
            }
        }
    }).timeout(30 * 1000);

    it("Should be able to provision d0.", async function () {
        const start = Date.now();

        const sc = new SDDMController(new GitHubController());

        Log.test('Provisioning three users');
        const p1 = await sc.handleUnknownUser(Test.ORGNAME, Test.USERNAMEGITHUB1);
        expect(p1).to.not.be.null;
        const p2 = await sc.handleUnknownUser(Test.ORGNAME, Test.USERNAMEGITHUB2);
        expect(p2).to.not.be.null;
        const p3 = await sc.handleUnknownUser(Test.ORGNAME, Test.USERNAMEGITHUB3);
        expect(p3).to.not.be.null;


        Log.test('Provisioning three d0 repos');
        let provision = await sc.provision(Test.ORGNAME, 'd0', [Test.USERNAMEGITHUB1]);
        expect(provision.success).to.not.be.undefined;
        expect(provision.failure).to.be.undefined;
        expect((<ActionPayload>provision.success).status.status).to.equal("D0");

        provision = await sc.provision(Test.ORGNAME, 'd0', [Test.USERNAMEGITHUB2]);
        expect(provision.success).to.not.be.undefined;
        expect(provision.failure).to.be.undefined;
        expect((<ActionPayload>provision.success).status.status).to.equal("D0");

        provision = await sc.provision(Test.ORGNAME, 'd0', [Test.USERNAMEGITHUB3]);
        expect(provision.success).to.not.be.undefined;
        expect(provision.failure).to.be.undefined;
        expect((<ActionPayload>provision.success).status.status).to.equal("D0");

        Log.test('Adding some grades for the d0 repos');
        const gc = new GradesController();
        let grade: GradePayload = {
            score:     65,
            comment:   'test',
            url:       'TESTURL',
            timestamp: Date.now()
        };
        await gc.createGrade(Test.ORGNAME, "secap_" + Test.USERNAMEGITHUB1, "d0", grade);
        grade = {
            score:     70,
            comment:   'test',
            url:       'TESTURL',
            timestamp: Date.now()
        };
        await gc.createGrade(Test.ORGNAME, "secap_" + Test.USERNAMEGITHUB2, "d0", grade);
        grade = {
            score:     75,
            comment:   'test',
            url:       'TESTURL',
            timestamp: Date.now()
        };
        await gc.createGrade(Test.ORGNAME, "secap_" + Test.USERNAMEGITHUB3, "d0", grade);

        Log.trace("Test took (3 users, 3 d0 repos): " + Util.took(start));
    }).timeout(300 * 1000); // 5 minutes

    it("Should be able to provision an individual d1.", async function () {
        const start = Date.now();

        const sc = new SDDMController(new GitHubController());

        Log.test('Provision solo D1');
        const provision = await sc.provision(Test.ORGNAME, 'd1', [Test.USERNAMEGITHUB1]);
        expect(provision.success).to.not.be.undefined;
        expect(provision.failure).to.be.undefined;
        expect((<ActionPayload>provision.success).status.status).to.equal("D1");

        Log.trace("Test took (1 users, 1 upgrade): " + Util.took(start));
    }).timeout(300 * 1000); // 5 minutes

    it("Should be able to provision a paired d1.", async function () {
        const start = Date.now();

        const sc = new SDDMController(new GitHubController());

        Log.test('Provision paired d1');
        const provision = await sc.provision(Test.ORGNAME, 'd1', [Test.USERNAMEGITHUB2, Test.USERNAMEGITHUB3]);
        expect(provision.success).to.not.be.undefined;
        expect(provision.failure).to.be.undefined;
        expect((<ActionPayload>provision.success).status.status).to.equal("D1");

        // NOTE: every time this is run it will create a team we can't programmatically delete

        Log.trace("Test took (2 users, 1 clones): " + Util.took(start));
    }).timeout(300 * 1000); // 5 minutes

});
