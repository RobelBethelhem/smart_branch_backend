const roleCheck = (roles) => {
  
    return (req, res, next) => {

     



      const rolesLength = roles.length;
      let matchFound = false; // Flag to track if a match is found
  
      for (let i = 0; i < rolesLength; i++) {
        const cus_roles = [roles[i]];
  
        if (req.user.roles.includes(...cus_roles)) {
          matchFound = true;
          break; // Exit the loop if a match is found
        }
      }
  
      if (matchFound) {
        next(); // Call next middleware if a match is found
      } else {
        res.status(403).json({ error: true, message: "You are not authorized" });
      }
    };
  };
  
  export default roleCheck;




















// const roleCheck = (roles) => {
//   return (req, res, next) => {
//     console.log("roles", roles);
//     console.log("req.user.roles", req.user.roles);

//     // Split the roles string into an array
//     const rolesArray = roles[0].split(',').map(role => role.trim());
    
//     const rolesLength = rolesArray.length;
//     let matchFound = false; // Flag to track if a match is found

//     for (let i = 0; i < rolesLength; i++) {
//       const cus_roles = [rolesArray[i]];

//       if (req.user.roles.includes(...cus_roles)) {
//         matchFound = true;
//         break; // Exit the loop if a match is found
//       }
//     }

//     if (matchFound) {
//       next(); // Call next middleware if a match is found
//     } else {
//       res.status(403).json({ error: true, message: "You are not authorized" });
//     }
//   };
// };

// export default roleCheck;