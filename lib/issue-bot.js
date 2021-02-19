const core = require('@actions/core');
const { context, getOctokit } = require('@actions/github');
const handlebars = require('handlebars');

const token = process.env.GITHUB_TOKEN;
const octokit = getOctokit(token);

// {key1: '', key2: 'some string', key3: undefined} => {key2: 'some string'}
const removeEmptyProps = (obj) => {
  for (const key in obj) {
    if (obj[key] === '' || typeof obj[key] === 'undefined') {
      delete obj[key];
    }
  }
  return obj;
};

const needPreviousIssue = (...conditions) => {
  return conditions.includes(true);
};

const issueExists = (previousIssueNumber) => {
  return previousIssueNumber >= 0;
};

const checkInputs = (inputs) => {
  core.info(`Checking inputs: ${JSON.stringify(inputs)}`);

  let ok = true;

  ok = !!inputs.title;

  if (inputs.pinned) {
    ok = !!inputs.labels;
  }
  if (inputs.closePrevious) {
    ok = !!inputs.labels;
  }
  if (inputs.linkedComments) {
    ok = !!inputs.labels;
  }
  if (inputs.rotateAssignees) {
    ok = !!(inputs.labels && inputs.assignees);
  }

  return ok;
};

const getNextAssignee = (assignees, previousAssignee) => {
  core.info(`Getting next assignee from ${JSON.stringify(assignees)} with previous assignee ${previousAssignee}}`);

  const index = (assignees.indexOf(previousAssignee) + 1) % assignees.length;

  core.info(`Next assignee: ${assignees[index]}`);

  return [assignees[index]];
};

// Is issue with issueId already pinned to this repo?
const isPinned = async (issueId) => {
  core.info(`Checking if issue ${issueId} is pinned.`);

  const query = `{
    resource(url: "${context.repo}") {
      ... on Repository {
        pinnedIssues(last: 3) {
          nodes {
            issue {
              id
            }
          }
        }
      }
    }
  }`;
  const data = await octokit.graphql({
    query,
    headers: {
      accept: 'application/vnd.github.elektra-preview+json'
    }
  });

  core.debug(`isPinned data: ${JSON.stringify(data)}`);

  if (!data.resource) {
    return false;
  }

  const pinnedIssues = data.resource.pinnedIssues.nodes || [];
  return pinnedIssues.findIndex(pinnedIssue => pinnedIssue.issue.id === issueId) >= 0;
};

// Given a GraphQL issue id, unpin the issue
const unpin = async (issueId) => {
  if (!(await isPinned(issueId))) {
    return;
  }

  core.info(`Unpinning ${issueId}...`);

  const mutation = `mutation {
    unpinIssue(input: {issueId: "${issueId}"}) {
      issue {
        body
      }
    }
  }`;

  return octokit.graphql({
    query: mutation,
    headers: {
      accept: 'application/vnd.github.elektra-preview+json'
    }
  });
};

// Given a GraphQL issue id, pin the issue
const pin = async (issueId) => {
  core.info(`Pinning ${issueId}...`);

  const mutation = `mutation {
    pinIssue(input: {issueId: "${issueId}"}) {
        issue {
          body
        }
      }
    }`;
    // TODO check if 3 issues are already pinned
  return octokit.graphql({
    query: mutation,
    headers: {
      accept: 'application/vnd.github.elektra-preview+json'
    }
  });
};

const createNewIssue = async (options) => {
  // Remove empty props in order to make valid API calls
  options = removeEmptyProps(Object.assign({}, options));

  core.info(`Creating new issue with options: ${JSON.stringify(options)} and body: ${options.body}`);

  const { data: { number: newIssueNumber, id: newIssueId, node_id: newIssueNodeId } } = (await octokit.issues.create({
    ...context.repo,
    title: options.title,
    labels: options.labels,
    assignees: options.assignees,
    body: options.body
  })) || {};

  core.debug(`New issue number: ${newIssueNumber}`);
  core.debug(`New issue id: ${newIssueId}`);
  core.debug(`New issue node ID: ${newIssueNodeId}`);

  return {
    newIssueNumber: Number(newIssueNumber),
    newIssueId,
    newIssueNodeId
  };
};

const closeIssue = async (issueNumber) => {
  core.info(`Closing issue number ${issueNumber}...`);

  return await octokit.issues.update({
    ...context.repo,
    issue_number: issueNumber,
    state: 'closed'
  });
};

const makeLinkedComments = async (newIssueNumber, previousIssueNumber) => {
  core.info(`Making linked comments on new issue number ${newIssueNumber} and previous issue number ${previousIssueNumber}`);

  // Create comment on the new that points to the previous
  await octokit.issues.createComment({
    ...context.repo,
    issue_number: newIssueNumber,
    body: `Previous in series: #${previousIssueNumber}`
  });

  // Create comment on the previous that points to the new
  await octokit.issues.createComment({
    ...context.repo,
    issue_number: previousIssueNumber,
    body: `Next in series: #${newIssueNumber}`
  });
};

// Return previous issue matching both labels
// @input labels: ['label1', 'label2']
const getPreviousIssue = async (labels) => {
  core.info(`Finding previous issue with labels: ${JSON.stringify(labels)}...`);

  let previousIssueNumber; let previousIssueNodeId; let previousAssignees = '';

  const data = (await octokit.issues.listForRepo({
    ...context.repo,
    labels
  })).data[0];

  if (data) {
    previousIssueNumber = data.number;
    previousIssueNodeId = data.node_id;
    previousAssignees = data.assignees;
  } else {
    core.warning(`Couldn't find previous issue with labels: ${JSON.stringify(labels)}. Proceeding anyway.`);
  }

  core.debug(`Previous issue number: ${previousIssueNumber}`);
  core.debug(`Previous issue node id: ${previousIssueNodeId}`);
  core.debug(`Previous issue assignees: ${previousAssignees}`);

  return {
    previousIssueNumber: previousIssueNumber ? Number(previousIssueNumber) : undefined,
    previousIssueNodeId,
    previousAssignees
  };
};

const addIssueToProjectColumn = async (issueId, projectNumber, columnName) => {
  core.info(`Adding issue id ${issueId} to project number ${projectNumber}, column name ${columnName}`);

  const { data: projects } = await octokit.projects.listForRepo({
    ...context.repo
  });

  core.debug(`Found repository projects: ${JSON.stringify(projects)}`);

  const project = projects.find(project => project.number === Number(projectNumber));

  if (!project) {
    core.warning(`Project with number ${projectNumber} could not be found in this repository. Proceeding without adding issue to project...`);
    return;
  }

  const { data: columns } = await octokit.projects.listColumns({
    project_id: project.id
  });

  core.debug(`Found columns for project id ${project.id}: ${JSON.stringify(columns)}`);

  const column = columns.find(column => column.name === columnName);

  core.debug(`Found column matching column name ${columnName}: ${JSON.stringify(column)}`);

  if (!column) {
    core.warning(`Column with name ${columnName} could not be found in repository project with id ${projectNumber}. Proceeding without adding issue to project...`);
    return;
  }

  core.debug(`Column name ${columnName} maps to column id ${column.id}`);

  await octokit.projects.createCard({
    column_id: column.id,
    content_id: issueId,
    content_type: 'Issue'
  });
};

const addIssueToMilestone = async (issueNumber, milestoneNumber) => {
  core.info(`Adding issue number ${issueNumber} to milestone number ${milestoneNumber}`);

  const { data: issue } = await octokit.issues.update({
    ...context.repo,
    issue_number: issueNumber,
    milestone: milestoneNumber
  });

  if (!issue) {
    core.warning(`Couldn't add issue ${issueNumber} to milestone ${milestoneNumber}. Proceeding without adding issue to milestone...`);
  }
};

/**
 * Takes provided inputs, acts on them, and produces a single output.
 * See action.yml for input descriptions.
 * @param {object} inputs
 */
const run = async (inputs) => {
  try {
    core.info(`Running with inputs: ${JSON.stringify(inputs)}`);

    let previousAssignee; let previousIssueNumber = -1; let previousIssueNodeId; let previousAssignees;

    if (needPreviousIssue(inputs.pinned, inputs.closePrevious, inputs.rotateAssignees, inputs.linkedComments)) {
      ({ previousIssueNumber, previousIssueNodeId, previousAssignees } = await getPreviousIssue(inputs.labels));
    }

    // Rotate assignee to next in list
    if (issueExists(previousIssueNumber) && inputs.rotateAssignees) {
      previousAssignee = previousAssignees.length ? previousAssignees[0].login : undefined;
      inputs.assignees = getNextAssignee(inputs.assignees, previousAssignee);
    }

    inputs.body = handlebars.compile(inputs.body)({ previousIssueNumber, assignees: inputs.assignees });
    const { newIssueNumber, newIssueId, newIssueNodeId } = await createNewIssue(inputs);

    if (inputs.project && inputs.column) {
      await addIssueToProjectColumn(newIssueId, inputs.project, inputs.column);
    }

    if (inputs.milestone) {
      await addIssueToMilestone(newIssueNumber, inputs.milestone);
    }

    // Write comments linking the current and previous issue
    if (issueExists(previousIssueNumber) && inputs.linkedComments) {
      await makeLinkedComments(newIssueNumber, previousIssueNumber);
    }

    // If there is a previous issue, close it out and point to the new
    if (issueExists(previousIssueNumber) && inputs.closePrevious) {
      await closeIssue(previousIssueNumber);

      // If the pinned input is true, pin the current, unpin the previous
      if (inputs.pinned) {
        await unpin(previousIssueNodeId);
        await pin(newIssueNodeId);
      }
    }

    if (newIssueNumber) {
      core.info(`New issue number: ${newIssueNumber}`);
      core.setOutput('issue-number', String(newIssueNumber));
    }
  } catch (error) {
    core.setFailed(`Error encountered: ${error}.`);
  }
};

exports.needPreviousIssue = needPreviousIssue;
exports.issueExists = issueExists;
exports.checkInputs = checkInputs;
exports.getNextAssignee = getNextAssignee;
exports.isPinned = isPinned;
exports.unpin = unpin;
exports.pin = pin;
exports.createNewIssue = createNewIssue;
exports.closeIssue = closeIssue;
exports.makeLinkedComments = makeLinkedComments;
exports.getPreviousIssue = getPreviousIssue;
exports.addIssueToProjectColumn = addIssueToProjectColumn;
exports.addIssueToMilestone = addIssueToMilestone;
exports.run = run;