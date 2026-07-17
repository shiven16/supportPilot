'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Make scopes nullable — PAT connections have no OAuth scope list
    await queryInterface.changeColumn('github_configs', 'scopes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('github_configs', 'scopes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: false
    });
  }
};
