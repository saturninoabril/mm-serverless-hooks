const axios = require('axios');
const {Octokit} = require('@octokit/rest');
const crypto = require('crypto');
const {Client} = require('pg');
const format = require('pg-format');

const GITHUB_EVENT_PULLS = 'pull_request';
const GITHUB_ACTION_LABELED = 'labeled';
const GITHUB_ACTION_UNLABELED = 'unlabeled';
const GITHUB_LABEL_QA_REVIEW = '3: QA Review';
const GITHUB_LABEL_QA_REVIEW_DONE = 'QA Review Done';

function isProd() {
    return process.env.NODE_ENV === 'production';
}

const ghWatchedRepos = isProd() ? process.env.GITHUB_WATCHED_REPOS : process.env.GITHUB_WATCHED_REPOS_DEV;
const ghToken = isProd() ? process.env.GITHUB_TOKEN : process.env.GITHUB_TOKEN_DEV;
const ghWebhookSecret = isProd() ? process.env.GITHUB_WEBHOOK_SECRET : process.env.GITHUB_WEBHOOK_SECRET_DEV;
const ghOwner = isProd() ? process.env.GITHUB_OWNER : process.env.GITHUB_OWNER_DEV;
const mmIncomingWebhook = isProd()
    ? process.env.MATTERMOST_INCOMING_WEBHOOK
    : process.env.MATTERMOST_INCOMING_WEBHOOK_DEV;

// Reuse DB connection
if (process.env.DATABASE_CONNECTION_STRING && typeof client === 'undefined') {
    // eslint-disable-line no-use-before-define
    var client = (client = new Client({
        connectionString: process.env.DATABASE_CONNECTION_STRING,
    }));

    client.connect();
}

function submitToDB(info, action, label, isDone) {
    client.query(`SELECT * FROM github_review WHERE html_url='${info.html_url}'`, (err, res) => {
        if (err) {
            console.log('Failed to get data from the database');
            return {err};
        } else {
            let prefixQuery = '';
            if (res.rows && res.rows.length === 0) {
                saveToDB(info, true, isDone);
            } else if (res.rows.length === 1) {
                if (action === GITHUB_ACTION_LABELED && label === GITHUB_LABEL_QA_REVIEW) {
                    prefixQuery = 'is_requested=true';
                } else if (action === GITHUB_ACTION_LABELED && label === GITHUB_LABEL_QA_REVIEW_DONE) {
                    prefixQuery = 'is_requested=true,is_done=true';
                }

                if (prefixQuery) {
                    updateItemToDB(res.rows[0].id, prefixQuery);
                }
            }
            return {data: res.rows};
        }
    });
}

function updateItemToDB(rowID, prefix) {
    const now = new Date().toUTCString();
    client.query(`UPDATE github_review SET ${prefix},updated_at='${now}' WHERE id='${rowID}'`, (err, res) => {
        if (err) {
            console.log('Failed to update item into the database');
        } else {
            console.log('Successfully updated item into the database');
        }
    });
}

function saveToDB(info, isRequested, isDone) {
    client.query(insertQuery(info, isRequested, isDone), (err, res) => {
        if (err) {
            console.log('Failed to save into the database');
        } else {
            console.log('Successfully save into the database');
        }
    });
}

function submitMessage(text) {
    axios({
        method: 'post',
        url: mmIncomingWebhook,
        data: {text},
    })
        .then((resp) => {
            console.log('Successfully sent to Mattermost');
        })
        .catch((err) => {
            // eslint-disable-line handle-callback-err
            console.log('Failed to sent to Mattermost');
        });
}

function labeledTemplate(info) {
    let emoji = '';
    let tag = '';
    let bySender = '';
    if (info.label === GITHUB_LABEL_QA_REVIEW) {
        tag = '#github_qa_review_request';
    } else if (info.label === GITHUB_LABEL_QA_REVIEW_DONE) {
        emoji = ':clap:';
        tag = '#github_qa_review_done';
        bySender = `by ${info.sender}`;
    }

    const {diffFiles, unitTestFiles, e2eTestFiles} = info;

    const filesChanged = `File/s changed: ${diffFiles.length}`;
    const unitTest = unitTestFiles.length > 0 ? `, Unit test: :white_check_mark:` : '';
    const e2eTest = e2eTestFiles.length > 0 ? `, E2E test: :100:` : '';

    return `
##### ${emoji} [${info.title}](${info.html_url})

${filesChanged}${unitTest}${e2eTest}

[${info.repo}] ${tag} ${bySender}
`;
}

function signRequestBody(key, body) {
    return `sha1=${crypto.createHmac('sha1', key).update(body, 'utf-8').digest('hex')}`;
}

function insertQuery(info, isRequested, isDone) {
    const now = new Date().toUTCString();
    const data = [
        [info.event, info.action, info.repo, info.sender, info.title, info.html_url, isRequested, isDone, now, now],
    ];

    return format(
        `
      INSERT INTO github_review (
          "event",
          "action",
          "repo",
          "sender",
          "title",
          "html_url",
          "is_requested",
          "is_done",
          "created_at",
          "updated_at"
      )
      VALUES %L RETURNING id`,
        data,
    );
}

function getDiff(repo, pullNumber) {
    const octokit = new Octokit({
        auth: ghToken,
    });

    return octokit.pulls
        .get({
            owner: ghOwner,
            repo: repo.split('/')[1],
            pull_number: pullNumber,
            mediaType: {
                format: 'diff',
            },
        })
        .then((resp) => {
            const diffFiles = resp.data
                .split('\n')
                .filter((d) => d.includes('diff --git'))
                .map((d) => d.split(' ')[3].substr(1));
            const unitTestFiles = diffFiles.filter(
                (d) => d.includes('_test.go') || d.includes('storetest') || d.includes('.test.'),
            );
            const e2eTestFiles = diffFiles.filter((d) => d.includes('_spec.'));

            return {
                status: resp.status,
                data: resp.data,
                diffFiles,
                unitTestFiles,
                e2eTestFiles,
            };
        })
        .catch((err) => {
            console.log('Failed to get diff of pull request:', pullNumber);
            return {error: err};
        });
}

module.exports.handler = (event, context, callback) => {
    if (!event || !event.body) {
        errMsg = 'Invalid event';
        console.log('NO EVENT: Must be valid event');
        return callback(null, {
            statusCode: 401,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    var errMsg;
    const headers = event.headers;
    const sig = headers['X-Hub-Signature'];
    const githubEvent = headers['X-GitHub-Event'];
    const id = headers['X-GitHub-Delivery'];
    const calculatedSig = signRequestBody(ghWebhookSecret, event.body);

    if (typeof ghWebhookSecret !== 'string') {
        errMsg = "Must provide a 'GITHUB_WEBHOOK_SECRET' env variable";
        console.log('NO TOKEN: Must provide a GITHUB_WEBHOOK_SECRET env variable');
        return callback(null, {
            statusCode: 401,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    if (!sig) {
        errMsg = 'No X-Hub-Signature found on request';
        console.log('NO SIGNATURE:', errMsg);
        return callback(null, {
            statusCode: 401,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    if (!githubEvent) {
        errMsg = 'No X-Github-Event found on request';
        console.log('NO GITHUB EVENT:', errMsg);
        return callback(null, {
            statusCode: 422,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    if (!id) {
        errMsg = 'No X-Github-Delivery found on request';
        console.log('NO ID:', errMsg);
        return callback(null, {
            statusCode: 401,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    if (sig !== calculatedSig) {
        errMsg = "X-Hub-Signature incorrect. Github webhook secret doesn't match";
        console.log('INVALID SIGNATURE:', errMsg);
        return callback(null, {
            statusCode: 401,
            headers: {'Content-Type': 'text/plain'},
            body: errMsg,
        });
    }

    const data = JSON.parse(event.body);
    const repo = data.repository.full_name;
    const action = data.action;
    const repos = ghWatchedRepos.split(',').map((r) => `${ghOwner}/${r}`);

    console.log('action:', action);

    if (
        (action === GITHUB_ACTION_LABELED || action === GITHUB_ACTION_UNLABELED) &&
        githubEvent === GITHUB_EVENT_PULLS &&
        repos.includes(repo)
    ) {
        const info = {
            event: githubEvent,
            action,
            repo,
            sender: data.sender.login,
            title: data[GITHUB_EVENT_PULLS].title,
            html_url: data[GITHUB_EVENT_PULLS].html_url,
        };

        const label = data.label.name;
        if ([GITHUB_LABEL_QA_REVIEW, GITHUB_LABEL_QA_REVIEW_DONE].includes(label)) {
            getDiff(repo, data.number).then((diffData) => {
                const message = labeledTemplate({
                    ...info,
                    label,
                    diffFiles: diffData.diffFiles,
                    unitTestFiles: diffData.unitTestFiles,
                    e2eTestFiles: diffData.e2eTestFiles,
                });

                submitMessage(message);
            });

            if (process.env.DATABASE_CONNECTION_STRING) {
                console.log('SUBMIT TO DB');
                // P2: will remove once DB is setup
                submitToDB(info, action, label, label === GITHUB_LABEL_QA_REVIEW_DONE);
            }
        }
    }

    const response = {
        statusCode: 200,
        body: JSON.stringify({
            input: event,
        }),
    };

    return callback(null, response);
};
