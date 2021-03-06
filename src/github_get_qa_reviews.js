const axios = require('axios');
const {Octokit} = require('@octokit/rest');

const ghWatchedRepos = isProd() ? process.env.GITHUB_WATCHED_REPOS : process.env.GITHUB_WATCHED_REPOS_DEV;
const ghToken = isProd() ? process.env.GITHUB_TOKEN : process.env.GITHUB_TOKEN_DEV;
const ghOwner = isProd() ? process.env.GITHUB_OWNER : process.env.GITHUB_OWNER_DEV;
const ghQAUsers = isProd() ? process.env.GITHUB_QA_USERS : process.env.GITHUB_QA_USERS_DEV;
const mmIncomingWebhook = isProd()
    ? process.env.MATTERMOST_INCOMING_WEBHOOK
    : process.env.MATTERMOST_INCOMING_WEBHOOK_DEV;

function isProd() {
    return process.env.NODE_ENV === 'production';
}

function getPullRequests(repo) {
    const octokit = new Octokit({
        auth: ghToken,
    });

    return octokit.pulls
        .list({
            owner: ghOwner,
            repo,
            state: 'open',
            per_page: 100,
        })
        .then((resp) => {
            return {repo, status: resp.status, data: resp.data};
        })
        .catch((err) => {
            console.log('Failed to get Github list of pull request:', repo);
            return {error: err};
        });
}

async function getPRs(repo) {
    const prs = await getPullRequests(repo);

    return prs;
}

function getPRLabel(pr) {
    return pr.labels.reduce((acc, el) => {
        acc.push(el.name);
        return acc;
    }, []);
}

function getPRReviewer(pr) {
    return pr.requested_reviewers.reduce((acc, el) => {
        acc.push(el.login);
        return acc;
    }, []);
}

function getQAReviewer(reviewers = []) {
    const qaReviewer = [];
    reviewers.forEach((rev) => {
        if (ghQAUsers.includes(rev)) {
            qaReviewer.push(rev);
        }
    });

    return qaReviewer;
}

function groupPRsPerQA(PRs = [], repo) {
    return PRs.filter((pr) => getPRLabel(pr).includes('3: QA Review'))
        .map((pr) => {
            const reviewers = getPRReviewer(pr);
            return {
                author: pr.user.login,
                labels: getPRLabel(pr),
                milestone: pr.milestone ? pr.milestone.title : '',
                qa_reviewer: getQAReviewer(reviewers),
                repo,
                reviewers,
                title: pr.title,
                url: pr.html_url,
            };
        })
        .sort((a, b) => {
            const aReviewer = a.qa_reviewer.join('');
            const bReviewer = b.qa_reviewer.join('');

            if (aReviewer < bReviewer) {
                return -1;
            } else if (aReviewer > bReviewer) {
                return 1;
            }

            return 0;
        });
}

function generateTemplate(repo, totalPR, qaPRs) {
    var today = new Date();

    const lines = [];
    qaPRs.forEach((pr) => {
        const milestone = pr.milestone ? `[${pr.milestone}]` : '';
        const line = `- (${pr.qa_reviewer.length > 0 ? pr.qa_reviewer.join(', ') : ':point_up:'}) [${pr.title}](${
            pr.url
        }) ${milestone} `;
        lines.push(line);
    });

    return `
---
${repo}
---

Total Open PRs: **${totalPR}**
Open for QA review: **${qaPRs.length}**

${lines.join('\n')}

#github_qa_review #${today.toDateString().replace(/\s/g, '_')}
`;
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
            console.log('Failed to sent to Mattermost');
        });
}

module.exports.handler = (event, context, callback) => {
    const output = [];
    ghWatchedRepos.split(',').forEach((repo) => {
        output.push(getPRs(repo));
    });

    Promise.all(output).then((out) => {
        out.forEach((prs) => {
            if (prs && prs.data) {
                const qaLabelled = groupPRsPerQA(prs.data, prs.repo);

                const text = generateTemplate(prs.repo, prs.data.length, qaLabelled);

                submitMessage(text);
            }
        });
    });

    const response = {
        statusCode: 200,
        body: JSON.stringify({
            input: {message: 'Successfully posted'},
        }),
    };

    return callback(null, response);
};
