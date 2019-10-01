const axios = require('axios');
const crypto = require('crypto');
const {Client} = require('pg');
const format = require('pg-format');

const GITHUB_EVENT_PULLS = 'pull_request';
const GITHUB_ACTION_LABELED = 'labeled';
const GITHUB_LABEL_QA_REVIEW = '2: QA Review';
const GITHUB_LABEL_QA_REVIEW_DONE = 'QA Review Done';

// Reuse DB connection
if (process.env.DATABASE_CONNECTION_STRING && typeof client === 'undefined') {
    // eslint-disable-line no-use-before-define
    var client = (client = new Client({
        connectionString: process.env.DATABASE_CONNECTION_STRING,
    }));

    client.connect();
}

function submitToDB(info, action, label, isDone) {
    client.query(
        `SELECT * FROM github_review WHERE html_url='${info.html_url}'`,
        (err, res) => {
            if (err) {
                console.log('Failed to get data from the database');
                return {err};
            } else {
                let prefixQuery = '';
                if (res.rows && res.rows.length === 0) {
                    saveToDB(info, true, isDone);
                } else if (res.rows.length === 1) {
                    if (
                        action === GITHUB_ACTION_LABELED &&
                        label === GITHUB_LABEL_QA_REVIEW
                    ) {
                        prefixQuery = 'is_requested=true';
                    } else if (
                        action === GITHUB_ACTION_LABELED &&
                        label === GITHUB_LABEL_QA_REVIEW_DONE
                    ) {
                        prefixQuery = 'is_requested=true,is_done=true';
                    }

                    if (prefixQuery) {
                        updateItemToDB(res.rows[0].id, prefixQuery);
                    }
                }
                return {data: res.rows};
            }
        },
    );
}

function updateItemToDB(rowID, prefix) {
    const now = new Date().toUTCString();
    client.query(
        `UPDATE github_review SET ${prefix},updated_at='${now}' WHERE id='${rowID}'`,
        (err, res) => {
            if (err) {
                console.log('Failed to update item into the database');
            } else {
                console.log('Successfully updated item into the database');
            }
        },
    );
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
        url: process.env.MATTERMOST_INCOMING_WEBHOOK,
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
    if (info.label === GITHUB_LABEL_QA_REVIEW) {
        tag = '#github_qa_review_request';
    } else if (info.label === GITHUB_LABEL_QA_REVIEW_DONE) {
        emoji = ':clap:';
        tag = '#github_qa_review_done';
    }
    return `
##### ${emoji} [${info.title}](${info.html_url})

[${info.repo}] ${tag} by ${info.sender}
`;
}

function signRequestBody(key, body) {
    return `sha1=${crypto
        .createHmac('sha1', key)
        .update(body, 'utf-8')
        .digest('hex')}`;
}

function insertQuery(info, isRequested, isDone) {
    const now = new Date().toUTCString();
    const data = [
        [
            info.event,
            info.action,
            info.repo,
            info.sender,
            info.title,
            info.html_url,
            isRequested,
            isDone,
            now,
            now,
        ],
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

module.exports.default = (event, context, callback) => {
    var errMsg;
    const token = process.env.GITHUB_WEBHOOK_SECRET;
    const headers = event.headers;
    const sig = headers['X-Hub-Signature'];
    const githubEvent = headers['X-GitHub-Event'];
    const id = headers['X-GitHub-Delivery'];
    const calculatedSig = signRequestBody(token, event.body);

    if (typeof token !== 'string') {
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
        errMsg =
            "X-Hub-Signature incorrect. Github webhook token doesn't match";
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
    const repos = process.env.GITHUB_WATCHED_REPOS.split(',').map(
        (r) => `${process.env.GITHUB_OWNER}/${r}`,
    );

    console.log('GITHUB_EVENT:', githubEvent);
    console.log('REPO:', repo);
    console.log('ACTION:', action);

    if (
        action === GITHUB_ACTION_LABELED &&
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
        console.log('LABEL:', label);
        if (
            [GITHUB_LABEL_QA_REVIEW, GITHUB_LABEL_QA_REVIEW_DONE].includes(
                label,
            )
        ) {
            const message = labeledTemplate({
                ...info,
                label,
            });

            submitMessage(message);

            if (process.env.DATABASE_CONNECTION_STRING) {
                console.log('SUBMIT TO DB');
                // P2: will remove once DB is setup
                submitToDB(
                    info,
                    action,
                    label,
                    label === GITHUB_LABEL_QA_REVIEW_DONE,
                );
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
