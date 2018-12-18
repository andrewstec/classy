import * as Docker from "dockerode";
import * as fs from "fs-extra";
import {URL} from "url";
import Config, {ConfigKey} from "../../../common/Config";
import Log from "../../../common/Log";
import {AutoTestResult} from "../../../common/types/AutoTestTypes";
import {CommitTarget, ContainerInput} from "../../../common/types/ContainerTypes";
import {AutoTestGradeTransport} from "../../../common/types/PortalTypes";
import Util from "../../../common/Util";
import {IClassPortal} from "./ClassPortal";
import {IDataStore} from "./DataStore";
import {GradingJob} from "./GradingJob";
import {MockGradingJob} from "./mocks/MockGradingJob";
import {Queue} from "./Queue";

export interface IAutoTest {
    /**
     * Adds a new job to be processed by the standard queue.
     *
     * @param {IContainerInput} element
     */
    addToStandardQueue(element: ContainerInput): void;

    // NOTE: add this when we support regression queues
    // addToRegressionQueue(element: IContainerInput): void;

    /**
     * Updates the internal clock of the handler. This might or might not do anything.
     *
     * But if there are execution slots available and the queue has elements it should
     * start jobs processing.
     */
    tick(): void;
}

export abstract class AutoTest implements IAutoTest {
    protected readonly dataStore: IDataStore;
    protected readonly classPortal: IClassPortal = null;

    private regressionQueue = new Queue('regression', 1);
    private standardQueue = new Queue('standard', 2);
    private expressQueue = new Queue('express', 1);
    private readonly docker: Docker;

    // noinspection TypeScriptAbstractClassConstructorCanBeMadeProtected
    constructor(dataStore: IDataStore, classPortal: IClassPortal) {
        this.dataStore = dataStore;
        this.classPortal = classPortal;

        if (Config.getInstance().getProp(ConfigKey.name) === "classytest") {
            // Running tests; don't need to connect to the Docker daemon
            this.docker = null;
        } else {
            const dockerHost = Config.getInstance().getProp(ConfigKey.dockerHost);
            if (dockerHost !== null && (dockerHost.startsWith("https") || dockerHost.startsWith("http") || dockerHost.startsWith("tcp"))) {
                const dockerUrl = new URL(dockerHost);
                this.docker = new Docker({
                    host: dockerUrl.hostname,
                    port: dockerUrl.port,
                    ca: fs.readFileSync("/etc/ssl/certs/ca-certificates.crt"),
                    cert: fs.readFileSync(Config.getInstance().getProp(ConfigKey.sslCertPath)),
                    key: fs.readFileSync(Config.getInstance().getProp(ConfigKey.sslKeyPath)),
                    version: "v1.30"
                });
            } else {
                this.docker = new Docker();
            }
        }
    }

    public addToStandardQueue(input: ContainerInput): void {
        Log.info("AutoTest::addToStandardQueue(..) - start; commit: " + input.target.commitSHA);
        try {
            this.standardQueue.push(input);
        } catch (err) {
            Log.error("AutoTest::addToStandardQueue(..) - ERROR: " + err);
        }
    }

    public tick() {
        try {
            Log.info("AutoTest::tick(..) - start; " +
                "standard - #wait: " + this.standardQueue.length() + ", #run: " + this.standardQueue.numRunning() + "; " +
                "express - #wait: " + this.expressQueue.length() + ", #run: " + this.expressQueue.numRunning() + "; " +
                "regression - #wait: " + this.regressionQueue.length() + ", #run: " + this.regressionQueue.numRunning() + ".");

            let updated = false;
            const that = this;

            const schedule = function(queue: Queue): boolean {
                const info: ContainerInput = queue.scheduleNext();
                Log.info("AutoTest::tick(..) - starting job on: " + queue.getName() + "; deliv: " +
                    info.delivId + '; repo: ' + info.target.repoId + '; SHA: ' + info.target.commitSHA);

                let gradingJob: GradingJob;
                // Use mocked GradingJob if testing; EMPTY and POSTBACK used by test environment
                if (info.target.postbackURL === "EMPTY" || info.target.postbackURL === "POSTBACK") {
                    Log.warn("AutoTest::tick(..) - Running grading job in test mode.");
                    gradingJob = new MockGradingJob(info);
                } else {
                    gradingJob = new GradingJob(info);
                }

                // noinspection JSIgnoredPromiseFromCall
                // tslint:disable-next-line
                that.handleTick(gradingJob); // NOTE: not awaiting on purpose (let it finish in the background)!
                updated = true;
                return true;
            };

            const tickQueue = function(queue: Queue): boolean {
                if (queue.length() > 0 && queue.hasCapacity() === true) {
                    return schedule(queue);
                }
                return false;
            };

            const promoteQueue = function(fromQueue: Queue, toQueue: Queue): boolean {
                if (fromQueue.length() > 0 && toQueue.hasCapacity()) {
                    Log.info("AutoTest::tick(..) - promoting: " + fromQueue.getName() + " -> " + toQueue.getName());
                    const info: ContainerInput = fromQueue.pop();
                    toQueue.pushFirst(info);
                    return schedule(toQueue);
                }
                return false;
            };

            // express
            // Log.trace("Queue::tick(..) - handle express");
            tickQueue(this.expressQueue);
            // express -> standard
            promoteQueue(this.expressQueue, this.standardQueue);
            // express -> regression
            promoteQueue(this.expressQueue, this.regressionQueue);

            // standard
            // Log.trace("Queue::tick(..) - handle standard");
            tickQueue(this.standardQueue);
            // standard -> regression
            promoteQueue(this.standardQueue, this.regressionQueue);

            // regression
            // Log.trace("Queue::tick(..) - handle regression");
            tickQueue(this.regressionQueue);

            // if (updated === false) {
            if (this.standardQueue.length() === 0 && this.standardQueue.numRunning() === 0 &&
                this.expressQueue.length() === 0 && this.expressQueue.numRunning() === 0 &&
                this.regressionQueue.length() === 0 && this.regressionQueue.numRunning() === 0) {
                Log.info("AutoTest::tick(..) - done: queues empty and idle; no new jobs started.");
            } else {
                // Log.info("AutoTest::tick(..) - done - execution slots busy; no new jobs started");
                Log.info("AutoTest::tick(..) - done: " +
                    "standard - #wait: " + this.standardQueue.length() + ", #run: " + this.standardQueue.numRunning() + "; " +
                    "express - #wait: " + this.expressQueue.length() + ", #run: " + this.expressQueue.numRunning() + "; " +
                    "regression - #wait: " + this.regressionQueue.length() + ", #run: " + this.regressionQueue.numRunning() + ".");
            }
            // }
        } catch (err) {
            Log.error("AutoTest::tick() - ERROR: " + err.message);
        }
    }

    /**
     * This is the main extension point for a subclass to respond to an execution completing.
     * The record will be persisted by AutoTest, but any kind of reporting back to users will
     * have to be handled by subclasses.
     *
     * If subclasses do not want to do anything, they can just `return Promise.resolve();`
     * in their implementation.
     *
     * @param {IAutoTestResult} data
     * @returns {Promise<void>}
     */
    protected abstract processExecution(data: AutoTestResult): Promise<void>;

    /**
     * Returns whether the commitURL is currently executing the given deliverable.
     *
     * @param commitURL
     * @param delivId
     */
    protected isCommitExecuting(commitURL: string, delivId: string): boolean {
        try {
            if (this.standardQueue.isCommitExecuting(commitURL, delivId) === true) {
                return true;
            }

            if (this.expressQueue.isCommitExecuting(commitURL, delivId) === true) {
                return true;
            }

            if (this.regressionQueue.isCommitExecuting(commitURL, delivId) === true) {
                return true;
            }

            return false;
        } catch (err) {
            Log.error("AutoTest::isCommitExecuting() - ERROR: " + err);
        }
    }

    /**
     * Checks to see of a commitURL is queued or is currently being executed
     *
     * @param {string} commitURL
     * @param {string} delivId
     * @returns {boolean}
     */
    protected isOnQueue(commitURL: string, delivId: string): boolean {
        let onQueue = false;
        try {
            if (this.isCommitExecuting(commitURL, delivId) === true) {
                onQueue = true;
            } else if (this.standardQueue.indexOf(commitURL) >= 0) {
                onQueue = true;
            } else if (this.expressQueue.indexOf(commitURL) >= 0) {
                onQueue = true;
            } else if (this.regressionQueue.indexOf(commitURL) >= 0) {
                onQueue = true;
            }
        } catch (err) {
            Log.error("AutoTest::isOnQueue() - ERROR: " + err);
        }
        return onQueue;
    }

    /**
     * Promotes a job to the express queue if it will help it to complete faster.
     *
     * This seems more complicated than it should because we want to recognize being
     * next in line on an non-express queue may be faster than last in line after being
     * promoted to the express queue.
     *
     * @param {ICommentEvent} info
     */
    protected promoteIfNeeded(info: CommitTarget): void {
        try {
            Log.trace("AutoTest::promoteIfNeeded() - start");

            if (this.isCommitExecuting(info.commitURL, info.delivId) === true) {
                Log.trace("AutoTest::promoteIfNeeded() - not needed; currently executing");
                return;
            }

            if (this.standardQueue.indexOf(info.commitURL) >= 0) {
                // is on the standard queue
                if (this.expressQueue.length() > this.standardQueue.indexOf(info.commitURL)) {
                    // faster to just leave it on the standard queue
                } else {
                    // promote to the express queue
                    const input = this.standardQueue.remove(info.commitURL);
                    if (input !== null) {
                        Log.trace("AutoTest::promoteIfNeeded() - job moved from standard to express queue: " + info.commitSHA);
                        this.expressQueue.push(input);
                    }
                }
            } else if (this.regressionQueue.indexOf(info.commitURL) >= 0) {
                // is on the regression queue
                if (this.expressQueue.length() > this.regressionQueue.indexOf(info.commitURL)) {
                    // faster to just leave it on the regression queue
                } else {
                    // promote to the express queue
                    const input = this.regressionQueue.remove(info.commitURL);
                    if (input !== null) {
                        Log.trace("AutoTest::promoteIfNeeded() - job moved from regression to express queue: " + info.commitSHA);
                        this.expressQueue.push(input);
                    }
                }
            } else {
                // not an error:
                // this happens if we try to promote after a job is done but before the queue is cleared
                // or if it is already on the express queue
            }
        } catch (err) {
            Log.error("AutoTest::promoteIfNeeded() - ERROR: " + err);
        }
    }

    /**
     * Called when a container completes.
     *
     * Persist record. (could decide to move this persistence into ClassPortal::sendResult in future)
     * Post back if specified by container output.
     * Post back if requested by TA
     * Post back if requested by user and quota allows (and record feedback given)
     *
     * @param data
     */
    private async handleExecutionComplete(data: AutoTestResult): Promise<void> {
        try {
            const start = Date.now();

            if (typeof data === "undefined" || data === null) {
                Log.warn("AutoTest::handleExecutionComplete(..) - null data; skipping");
                return;
            }

            if (typeof data.commitSHA === "undefined" ||
                typeof data.commitURL === "undefined" ||
                typeof data.input === "undefined" ||
                typeof data.output === "undefined") {
                Log.error("AutoTest::handleExecutionComplete(..) - missing required field; skipping; data: " + JSON.stringify(data));
                return;
            }

            Log.info("AutoTest::handleExecutionComplete(..) - start" +
                ": delivId: " + data.delivId + "; repoId: " + data.repoId +
                "; took (waiting + execution): " + Util.tookHuman(data.input.target.timestamp) +
                "; SHA: " + data.commitSHA);

            try {
                const resultPayload = await this.classPortal.sendResult(data);
                if (typeof resultPayload.failure !== 'undefined') {
                    Log.error("AutoTest::handleExecutionComplete(..) - ERROR; Classy rejected result record: " +
                        JSON.stringify(resultPayload));
                } else {
                    await this.processExecution(data);
                }
            } catch (err) {
                // just eat this error so subtypes do not break our queue handling
                Log.error("AutoTest::handleExecutionComplete(..) - ERROR; sending/processing: " + err);
            }

            // when done clear the execution slot and schedule the next
            const commitURL = data.commitURL;
            const delivId = data.delivId;
            this.expressQueue.clearExecution(commitURL, delivId);
            this.standardQueue.clearExecution(commitURL, delivId);
            this.regressionQueue.clearExecution(commitURL, delivId);

            // execution done, advance the clock
            this.tick();
            Log.info("AutoTest::handleExecutionComplete(..) - done; SHA: " + data.commitSHA +
                "; final processing took: " + Util.took(start));
        } catch (err) {
            Log.error("AutoTest::handleExecutionComplete(..) - ERROR: " + err.message);
        }
    }

    private async handleTick(job: GradingJob) {
        const start = Date.now();
        const input = job.input;
        let record = job.record;

        Log.info("AutoTest::handleTick(..) - start; delivId: " + input.delivId + "; SHA: " + input.target.commitSHA);
        Log.trace("AutoTest::handleTick(..) - input: " + JSON.stringify(input, null, 2));

        try {
            await job.prepare();
            record = await job.run(this.docker);

            let score = -1;
            if (record.output.report !== null && typeof record.output.report.scoreOverall !== "undefined") {
                score = record.output.report.scoreOverall;
            }
            const githubHost = Config.getInstance().getProp(ConfigKey.githubHost);
            const org = Config.getInstance().getProp(ConfigKey.org);
            const repoId = input.target.repoId;
            const gradePayload: AutoTestGradeTransport = {
                delivId: input.delivId,
                repoId,
                repoURL: `${githubHost}/${org}/${repoId}`,
                score,
                urlName: repoId,
                URL: input.target.commitURL,
                comment: '',
                timestamp: input.target.timestamp,
                custom: {}
            };

            await this.classPortal.sendGrade(gradePayload);
        } catch (err) {
            Log.error("AutoTest::handleTick(..) - ERROR for SHA: " + input.target.commitSHA + "; ERROR: " + err);
        } finally {
            await this.handleExecutionComplete(record);
            Log.info("AutoTest::handleTick(..) - complete; delivId: " + input.delivId +
                "; SHA: " + input.target.commitSHA + "; took: " + Util.tookHuman(start));
        }
    }
}
