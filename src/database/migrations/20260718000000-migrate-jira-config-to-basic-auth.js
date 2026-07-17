'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('jira_configs', 'email', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.changeColumn('jira_configs', 'refresh_token', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    await queryInterface.changeColumn('jira_configs', 'expires_at', {
      type: Sequelize.DATE,
      allowNull: true
    });
    await queryInterface.changeColumn('jira_configs', 'scopes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('jira_configs', 'email');
    await queryInterface.changeColumn('jira_configs', 'refresh_token', {
      type: Sequelize.TEXT,
      allowNull: false
    });
    await queryInterface.changeColumn('jira_configs', 'expires_at', {
      type: Sequelize.DATE,
      allowNull: false
    });
    await queryInterface.changeColumn('jira_configs', 'scopes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: false
    });
  }
};
